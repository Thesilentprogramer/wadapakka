"""Live Prisma/Timbre proxy. The API key never crosses the browser socket."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import ssl
import time
from contextlib import suppress

import certifi
import websockets
from fastapi import WebSocket, WebSocketDisconnect

from gnani_tts import DEFAULT_LANGUAGE, DEFAULT_MODEL, DEFAULT_VOICE, synthesize
from handoff import detect_handoff
from state_machine import State

TLS = ssl.create_default_context(cafile=certifi.where())

STT_URL = "wss://api.vachana.ai/stt/v3/stream"
TTS_URL = "wss://api.vachana.ai/api/v1/tts"


class ReadbackGate:
    """Streaming confirmations require a fully heard, uninterrupted read back."""
    def __init__(self):
        self.turn_id = 0
        self.awaiting = False
        self.played = False
        self.generated = False
        self.interrupted = False

    def begin(self, readback: bool) -> int:
        self.turn_id += 1
        self.awaiting = readback
        self.played = False
        self.generated = False
        self.interrupted = False
        return self.turn_id

    def generated_audio(self, turn_id: int) -> None:
        if turn_id == self.turn_id and not self.interrupted:
            self.generated = True

    def complete(self, turn_id: int) -> bool:
        if turn_id != self.turn_id or self.interrupted or not self.generated:
            return False
        self.played = True
        return True

    def cancel(self) -> bool:
        if self.interrupted:
            return False
        self.interrupted = True
        self.played = False
        return True

    def can_confirm(self) -> bool:
        return self.awaiting and self.played and not self.interrupted


async def live_socket(ws: WebSocket, session_id: str) -> None:
    from app import _handle_turn, sessions, text_is_confirmation

    await ws.accept()
    session = sessions.get(session_id)
    if not session:
        await ws.send_json({"type": "error", "message": "Unknown session"})
        await ws.close(code=1008)
        return
    key = os.getenv("GNANI_API_KEY", "").strip()
    if not key:
        await ws.send_json({"type": "error", "message": "GNANI_API_KEY is not configured"})
        await ws.close(code=1011)
        return

    lock = asyncio.Lock()
    gate = ReadbackGate()
    tts_task: asyncio.Task | None = None
    speech_end: float | None = None
    speech_start: float | None = None
    first_audio: float | None = None
    seen_segments: set[str] = set()
    active_turn: int | None = None

    async def send(message: dict) -> None:
        async with lock:
            await ws.send_json(message)

    async def cancel(source: str) -> None:
        nonlocal tts_task, active_turn
        if active_turn is None:
            return
        if not gate.cancel():
            return
        if tts_task and not tts_task.done():
            tts_task.cancel()
        tts_task = None
        interrupted = active_turn
        active_turn = None
        if session["turns"]:
            session["turns"][-1]["agent_interrupted"] = True
        # A half-heard read back can never authorize a confirmation.
        if gate.awaiting and session["state"] == State.CONFIRMING.value:
            session["state"] = State.CLARIFY.value
        await send({"type": "interrupted", "turn_id": interrupted, "source": source,
                    "reaction_ms": round((time.perf_counter() - speech_start) * 1000) if source == "prisma_speech_start" and speech_start else None,
                    "session": session})

    async def speak(prompt: str, turn_id: int) -> None:
        nonlocal first_audio
        payload = {"text": prompt, "voice": DEFAULT_VOICE, "model": DEFAULT_MODEL,
                   "language": DEFAULT_LANGUAGE, "speed": 1.0,
                   "audio_config": {"sample_rate": 16000, "num_channels": 1,
                                    "sample_width": 2, "encoding": "linear_pcm", "container": "raw"}}
        await send({"type": "agent_start", "turn_id": turn_id, "text": prompt,
                    "sample_rate": 16000})
        delivered = False
        try:
            async with websockets.connect(TTS_URL, additional_headers={"X-API-Key-ID": key}, ssl=TLS, open_timeout=10) as upstream:
                await upstream.send(json.dumps(payload))
                async for raw in upstream:
                    message = json.loads(raw)
                    if message.get("type") == "audio":
                        audio = message.get("data", {}).get("audio")
                        if audio:
                            if first_audio is None:
                                first_audio = time.perf_counter()
                                await send({"type": "tts_first_byte", "turn_id": turn_id,
                                            "end_to_audio_ms": round((first_audio - speech_end) * 1000) if speech_end else None})
                            await send({"type": "agent_audio", "turn_id": turn_id, "audio": audio})
                            delivered = True
                    elif message.get("type") == "complete":
                        break
                    elif message.get("type") == "error":
                        raise RuntimeError("Timbre streaming error")
        except asyncio.CancelledError:
            raise
        except Exception:
            # REST is only a fallback; it is never sent after an interruption.
            if not delivered:
                audio, meta = await asyncio.to_thread(synthesize, prompt)
                if not audio:
                    await send({"type": "error", "message": "Timbre unavailable"})
                    return
                # REST WAV contains a header. Strip it by parsing, not assuming 44 bytes.
                import io, wave
                with wave.open(io.BytesIO(audio), "rb") as wav:
                    pcm = wav.readframes(wav.getnframes())
                if first_audio is None:
                    first_audio = time.perf_counter()
                    await send({"type": "tts_first_byte", "turn_id": turn_id,
                                "end_to_audio_ms": round((first_audio - speech_end) * 1000) if speech_end else None})
                for offset in range(0, len(pcm), 8192):
                    await send({"type": "agent_audio", "turn_id": turn_id,
                                "audio": base64.b64encode(pcm[offset:offset + 8192]).decode()})
        gate.generated_audio(turn_id)
        await send({"type": "agent_done", "turn_id": turn_id})

    headers = {"X-API-Key-ID": key, "language_code": "hi-IN", "model": "prisma-v3.0",
               "format": "transcribe", "x-sample-rate": "16000", "x-vad-threshold": "0.55",
               "x-min-speech-ms": "100", "x-min-segment-ms": "100", "x-min-silence-ms": "500"}
    try:
        async with websockets.connect(STT_URL, additional_headers=headers, ssl=TLS, open_timeout=10) as stt:
            async def browser_to_stt() -> None:
                nonlocal speech_end, active_turn, tts_task
                while True:
                    incoming = await ws.receive()
                    if incoming["type"] == "websocket.disconnect":
                        raise WebSocketDisconnect()
                    frame = incoming.get("bytes")
                    if frame is not None:
                        if len(frame) == 1024:
                            await stt.send(frame)
                        else:
                            await send({"type": "error", "message": "PCM frame must be 1024 bytes"})
                        continue
                    raw = incoming.get("text")
                    if not raw:
                        continue
                    try:
                        control = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if control.get("type") == "barge_in":
                        await cancel("local_vad")
                    elif control.get("type") == "speech_end":
                        speech_end = time.perf_counter()
                    elif control.get("type") == "playback_done":
                        if gate.complete(control.get("turn_id")):
                            active_turn = None
                            tts_task = None
                            await send({"type": "playback_ack", "turn_id": gate.turn_id})
                    elif control.get("type") == "stop":
                        return

            async def stt_to_browser() -> None:
                nonlocal speech_start, speech_end, first_audio, tts_task, active_turn
                async for raw in stt:
                    event = json.loads(raw)
                    kind = event.get("type")
                    if kind == "connected":
                        await send({"type": "connected", "config": event.get("config")})
                        first_audio = None
                        active_turn = gate.begin(False)
                        tts_task = asyncio.create_task(speak("Namaste, main WadaPakka bol rahi hoon. Aap kab, kitna, aur kaise bharenge?", active_turn))
                    elif kind == "speech_start":
                        speech_start = time.perf_counter()
                        speech_end = None
                        await cancel("prisma_speech_start")
                        await send({"type": "speech_start", "utterance_id": event.get("utterance_id")})
                    elif kind == "processing":
                        speech_end = time.perf_counter()
                        await send({"type": "processing"})
                    elif kind == "transcript":
                        segment = event.get("segment_id")
                        if segment and segment in seen_segments:
                            continue
                        if segment:
                            seen_segments.add(segment)
                        text = (event.get("text") or "").strip()
                        metrics = {"end_to_final_ms": round((time.perf_counter() - speech_end) * 1000) if speech_end else None,
                                   "prisma_latency_ms": event.get("latency")}
                        await send({"type": "transcript", "text": text, "segment_id": segment,
                                    "utterance_id": event.get("utterance_id"), "latency": event.get("latency"),
                                    "is_final": event.get("is_final", True), "metrics": metrics})
                        if not text or session["state"] in {"HANDOFF", "REFUSED", "WRITTEN"}:
                            continue
                        if text_is_confirmation(text) and session["state"] == "CLARIFY" and gate.awaiting and gate.interrupted:
                            reply = {"session": session, "transcript": text, "prompt": "Pehle poora read back suniye. Maine note kiya: " + ", ".join(str(session["slots"].get(k)) for k in ("amount_inr", "pay_date", "mode")) + ". Kya yeh sahi hai?",
                                     "event": {"decision": "readback_repeated"}}
                            session["state"] = "CONFIRMING"
                        elif text_is_confirmation(text) and session["state"] == "CONFIRMING" and not gate.can_confirm():
                            reply = {"session": session, "transcript": text, "prompt": "Kripya poora read back suniye, phir haan boliye.",
                                     "event": {"decision": "confirmation_waiting_for_readback"}}
                        else:
                            reply = _handle_turn(session_id, text, "layer", None, {"source": "stream", "segment_id": segment}, metrics["end_to_final_ms"] or 0)
                        reply["metrics"] = metrics
                        await send({"type": "turn", **reply})
                        if reply.get("handoff_brief") or detect_handoff(text)["handoff"]:
                            await cancel("handoff")
                            await send({"type": "handoff", "brief": reply.get("handoff_brief")})
                            continue
                        prompt = reply.get("prompt")
                        if prompt:
                            first_audio = None
                            turn_id = gate.begin(reply.get("event", {}).get("decision") in {"readback", "readback_repeated", "confirmation_waiting_for_readback"})
                            active_turn = turn_id
                            tts_task = asyncio.create_task(speak(prompt, turn_id))
                    elif kind == "error":
                        await send({"type": "error", "message": event.get("message", "Prisma error")})
            tasks = [asyncio.create_task(browser_to_stt()), asyncio.create_task(stt_to_browser())]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                with suppress(asyncio.CancelledError, WebSocketDisconnect):
                    task.result()
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception:
        with suppress(Exception):
            await send({"type": "error", "message": "Streaming connection failed"})
    finally:
        if tts_task and not tts_task.done():
            tts_task.cancel()
        with suppress(Exception):
            await ws.close()
