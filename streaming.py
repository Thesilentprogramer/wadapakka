"""Live Prisma/Timbre proxy. The API key never crosses the browser socket."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import ssl
import time
import re
from contextlib import suppress

import certifi
import websockets
from fastapi import WebSocket, WebSocketDisconnect

from gnani_tts import DEFAULT_LANGUAGE, DEFAULT_MODEL, DEFAULT_VOICE, synthesize
from handoff import detect_handoff
from normalizer import parse_amount_inr, parse_relative_date, parse_mode
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


def accept_final(text: str, confirmed_speech: bool, during_playback: bool,
                 readback_complete: bool, interrupted: bool) -> bool:
    """Reject echo/filler finals before they can mutate a session."""
    clean = re.sub(r"[^\w\u0900-\u097f]+", "", text.lower())
    if not clean or len(clean) < 3:
        return False
    has_content = (parse_amount_inr(text)[0] is not None or
                   parse_relative_date(text)[0] is not None or
                   parse_mode(text)[0] is not None or
                   detect_handoff(text)["handoff"])
    filler = clean in {"haan", "han", "हाँ", "हां", "yes", "ok", "okay", "जी", "ji", "अच्छी", "achha", "अच्छा"}
    if filler and (during_playback or not (readback_complete or interrupted)):
        return False
    if during_playback and not has_content:
        return False
    return confirmed_speech or has_content


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
    confirmed_speech = False
    local_speech_at: float | None = None

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
        if gate.awaiting and session["state"] in {State.CONFIRMING.value, State.READBACK_PENDING.value, State.AWAITING_CONFIRMATION.value}:
            session["state"] = State.CLARIFY.value
            if session.get("proposal"):
                session["proposal"]["readback_status"] = "interrupted"
            session["active_proposal_id"] = None
        origin = speech_start if source == "prisma_speech_start" else local_speech_at
        await send({"type": "interrupted", "turn_id": interrupted, "source": source,
                    "proposal_id": session.get("proposal", {}).get("id") if session.get("proposal") else None,
                    "reaction_ms": round((time.perf_counter() - origin) * 1000) if origin else None,
                    "session": session})

    async def speak(prompt: str, turn_id: int) -> None:
        nonlocal first_audio
        if session.get("human_owned"):
            return
        payload = {"text": prompt, "voice": DEFAULT_VOICE, "model": DEFAULT_MODEL,
                   "language": DEFAULT_LANGUAGE, "speed": 1.0,
                   "audio_config": {"sample_rate": 16000, "num_channels": 1,
                                    "sample_width": 2, "encoding": "linear_pcm", "container": "raw"}}
        await send({"type": "agent_start", "turn_id": turn_id, "text": prompt,
                    "sample_rate": 16000})
        delivered = False
        completed = False
        try:
            async with websockets.connect(TTS_URL, additional_headers={"X-API-Key-ID": key}, ssl=TLS, open_timeout=10) as upstream:
                await upstream.send(json.dumps(payload))
                async for raw in upstream:
                    message = json.loads(raw)
                    if session.get("human_owned"):
                        return
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
                        completed = True
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
                if not pcm:
                    await send({"type": "error", "message": "Timbre returned empty read-back audio"})
                    return
                if first_audio is None:
                    first_audio = time.perf_counter()
                    await send({"type": "tts_first_byte", "turn_id": turn_id,
                                "end_to_audio_ms": round((first_audio - speech_end) * 1000) if speech_end else None})
                for offset in range(0, len(pcm), 8192):
                    if session.get("human_owned"):
                        return
                    await send({"type": "agent_audio", "turn_id": turn_id,
                                "audio": base64.b64encode(pcm[offset:offset + 8192]).decode()})
                delivered = True
                completed = True
        if completed and delivered:
            gate.generated_audio(turn_id)
            await send({"type": "agent_done", "turn_id": turn_id})
        else:
            await send({"type": "error", "message": "Read-back audio was incomplete",
                        "turn_id": turn_id, "proposal_id": session.get("active_proposal_id")})

    headers = {"X-API-Key-ID": key, "language_code": "hi-IN", "model": "prisma-v3.0",
               "format": "transcribe", "x-sample-rate": "16000", "x-vad-threshold": "0.55",
               "x-min-speech-ms": "100", "x-min-segment-ms": "100", "x-min-silence-ms": "500"}
    try:
        async with websockets.connect(STT_URL, additional_headers=headers, ssl=TLS, open_timeout=10) as stt:
            async def browser_to_stt() -> None:
                nonlocal speech_end, active_turn, tts_task, confirmed_speech, local_speech_at
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
                        if control.get("source") == "local_sustained" and control.get("sustained_ms", 0) >= 300:
                            local_speech_at = time.perf_counter()
                            confirmed_speech = True
                            await cancel("local_sustained")
                    elif control.get("type") == "speech_end":
                        speech_end = time.perf_counter()
                    elif control.get("type") == "playback_done":
                        if gate.complete(control.get("turn_id")):
                            if gate.awaiting and session.get("proposal") and session["state"] == State.READBACK_PENDING.value:
                                session["proposal"]["readback_status"] = "complete"
                                session["state"] = State.AWAITING_CONFIRMATION.value
                            active_turn = None
                            tts_task = None
                            await send({"type": "playback_ack", "turn_id": gate.turn_id,
                                        "proposal_id": session.get("active_proposal_id")})
                    elif control.get("type") == "stop":
                        return

            async def stt_to_browser() -> None:
                nonlocal speech_start, speech_end, first_audio, tts_task, active_turn, confirmed_speech
                async for raw in stt:
                    event = json.loads(raw)
                    kind = event.get("type")
                    if kind == "connected":
                        await send({"type": "connected", "config": event.get("config")})
                        first_audio = None
                        active_turn = gate.begin(False)
                        tts_task = asyncio.create_task(speak(session.get("opening_prompt", "Namaste."), active_turn))
                    elif kind == "speech_start":
                        speech_start = time.perf_counter()
                        confirmed_speech = True
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
                        during_playback = active_turn is not None
                        allowed = accept_final(text, confirmed_speech, during_playback,
                                               gate.can_confirm(), gate.interrupted)
                        metrics = {"end_to_final_ms": round((time.perf_counter() - speech_end) * 1000) if speech_end else None,
                                   "prisma_latency_ms": event.get("latency")}
                        await send({"type": "transcript", "text": text, "segment_id": segment,
                                    "utterance_id": event.get("utterance_id"), "latency": event.get("latency"),
                                    "is_final": event.get("is_final", True), "metrics": metrics,
                                    "ignored": not allowed})
                        if not event.get("is_final", True) or not allowed or session.get("human_owned") or session["state"] in {"HANDOFF", "REFUSED", "WRITTEN"}:
                            continue
                        confirmed_speech = False
                        reply = _handle_turn(session_id, text, "layer", None,
                                             {"source": "stream", "segment_id": segment,
                                              "readback_complete": gate.can_confirm()},
                                             metrics["end_to_final_ms"] or 0)
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
        from app import end_session
        end_session(session_id)
        if tts_task and not tts_task.done():
            tts_task.cancel()
        with suppress(Exception):
            await ws.close()
