"""WadaPakka reliability layer — turn-based REST plus live streaming WebSocket."""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv()

from gnani_stt import dual_pass, transcribe_rest
from gnani_tts import synthesize
from handoff import brief as handoff_brief
from handoff import detect_handoff
from idempotency import Ledger
from observability import TurnLog
from slots import extract_slots
from state_machine import State, can_move
from verifier import assess, readback_prompt


REST_AUDIO_SUFFIXES = {".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a"}


def _prepare_audio(raw: bytes, filename: str, content_type: str) -> tuple[bytes, str, str]:
    """REST STT docs list WAV, MP3, OGG, FLAC, AAC, M4A — not WebM.

    Browser MediaRecorder usually emits webm/opus or mp4, so convert those
    to 16 kHz mono WAV with ffmpeg before calling Prisma.
    """
    suffix = Path(filename or "turn.bin").suffix.lower()
    if suffix in REST_AUDIO_SUFFIXES:
        return raw, filename, content_type
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / f"input{suffix or '.bin'}"
        dst = Path(tmp) / "turn.wav"
        src.write_bytes(raw)
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(src),
                "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
                str(dst),
            ],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0 or not dst.exists():
            raise HTTPException(
                400,
                {
                    "error": "audio_conversion_failed",
                    "detail": (proc.stderr or "")[-400:],
                    "note": "Prisma REST accepts WAV, MP3, OGG, FLAC, AAC, M4A. WebM is converted via ffmpeg.",
                },
            )
        return dst.read_bytes(), "turn.wav", "audio/wav"


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="WadaPakka reliability layer", version="0.1.0")
if STATIC.exists():
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
if WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="web-assets")

sessions: dict[str, dict[str, Any]] = {}
ledger = Ledger()
turn_log = TurnLog()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _move(session: dict[str, Any], nxt: State) -> None:
    current = State(session["state"])
    if current != nxt and not can_move(current, nxt):
        raise HTTPException(400, f"illegal transition {current} -> {nxt}")
    session["state"] = nxt.value


@app.get("/")
def index() -> FileResponse:
    return FileResponse((WEB_DIST if WEB_DIST.is_dir() else STATIC) / "index.html")


@app.post("/api/session")
def create_session() -> dict[str, Any]:
    sid = str(uuid.uuid4())
    sessions[sid] = {
        "id": sid,
        "state": State.GREETING.value,
        "slots": {},
        "pending": [],
        "turns": [],
        "created_at": _now(),
        "account": {
            "name": "Ravi Kumar",
            "outstanding_inr": 2500,
            "note": "Synthetic demo account. No real borrower data.",
        },
    }
    _move(sessions[sid], State.COLLECTING)
    greeting = (
        "Namaste, main WadaPakka bol rahi hoon. "
        "Aapka outstanding 2500 rupaye hai. "
        "Aap kab, kitna, aur kaise bharenge?"
    )
    return {"session": sessions[sid], "prompt": greeting}


class TextTurn(BaseModel):
    session_id: str
    transcript: str
    mode: str = Field(default="layer", pattern="^(naive|layer)$")
    verbatim: str | None = None
    dual_pass: bool = False


@app.post("/api/turn-text")
def turn_text(body: TextTurn) -> dict[str, Any]:
    return _handle_turn(
        session_id=body.session_id,
        transcript=body.transcript,
        mode=body.mode,
        verbatim=body.verbatim,
        stt_meta={"source": "text", "dual_pass": body.dual_pass},
        latency_ms=0,
    )


@app.post("/api/turn")
async def turn_audio(
    session_id: str = Form(...),
    mode: str = Form("layer"),
    dual_pass_flag: bool = Form(False),
    audio: UploadFile = File(...),
) -> dict[str, Any]:
    if mode not in {"naive", "layer"}:
        raise HTTPException(400, "mode must be naive or layer")
    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty audio")
    filename = audio.filename or "turn.webm"
    content_type = audio.content_type or "application/octet-stream"
    raw, filename, content_type = _prepare_audio(raw, filename, content_type)
    started = time.perf_counter()
    verbatim = None
    if dual_pass_flag and mode == "layer":
        both = dual_pass(raw, filename=filename)
        primary = both["transcribe"]
        secondary = both["verbatim"]
        if not primary.get("success"):
            raise HTTPException(502, {"stt": primary})
        transcript = primary.get("transcript") or ""
        if secondary.get("success"):
            verbatim = secondary.get("transcript") or ""
        stt_meta = {"source": "rest_dual_pass", "transcribe": primary, "verbatim": secondary}
    else:
        primary = transcribe_rest(raw, filename=filename, content_type=content_type)
        if not primary.get("success"):
            raise HTTPException(502, {"stt": primary})
        transcript = primary.get("transcript") or ""
        stt_meta = {"source": "rest", "response": primary}
    latency_ms = int((time.perf_counter() - started) * 1000)
    return _handle_turn(
        session_id=session_id,
        transcript=transcript,
        mode=mode,
        verbatim=verbatim,
        stt_meta=stt_meta,
        latency_ms=latency_ms,
    )


def _handle_turn(
    session_id: str,
    transcript: str,
    mode: str,
    verbatim: str | None,
    stt_meta: dict[str, Any],
    latency_ms: int,
) -> dict[str, Any]:
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "unknown session")
    if session["state"] == State.WRITTEN.value and mode == "layer" and text_is_confirmation(transcript):
        slots = session["slots"]
        result = ledger.commit(session["id"], slots["amount_inr"], slots["pay_date"], slots["mode"])
        event = _record_turn(session, mode, transcript, stt_meta, latency_ms, {"decision": "duplicate_confirmation", "commit": result})
        return {"session": session, "transcript": transcript, "prompt": "Promise pehle hi likh diya gaya hai.", "commit": result, "event": event}
    if session["state"] in {State.WRITTEN.value, State.HANDOFF.value, State.REFUSED.value}:
        raise HTTPException(409, f"session already {session['state']}")

    text = (transcript or "").strip()
    hand = detect_handoff(text)
    if hand["handoff"] and mode == "layer":
        _move(session, State.HANDOFF)
        note = handoff_brief(session.get("slots") or {}, text, hand["reason"])
        event = _record_turn(session, mode, text, stt_meta, latency_ms, {
            "decision": "handoff",
            "handoff": hand,
            "brief": note,
        })
        return {
            "session": session,
            "transcript": text,
            "prompt": "Theek hai, main aapko abhi ek saathi se jod rahi hoon.",
            "handoff_brief": note,
            "event": event,
        }

    lowered = text.lower()
    if any(w in lowered for w in ("nahi dena", "nahi bharunga", "won't pay", "refuse")):
        if mode == "layer":
            _move(session, State.REFUSED)
            event = _record_turn(session, mode, text, stt_meta, latency_ms, {"decision": "refused"})
            return {"session": session, "transcript": text, "prompt": "Theek hai, maine note kar liya.", "event": event}

    if mode == "naive":
        return _naive_commit(session, text, stt_meta, latency_ms)

    return _layer_turn(session, text, verbatim, stt_meta, latency_ms)


def _naive_commit(
    session: dict[str, Any],
    text: str,
    stt_meta: dict[str, Any],
    latency_ms: int,
) -> dict[str, Any]:
    """Write on first parseable guess. This is the before/after contrast."""
    fill = extract_slots(text)
    session["slots"] = fill.as_dict()
    if fill.amount_inr and fill.pay_date and fill.mode:
        result = ledger.commit(session["id"], fill.amount_inr, fill.pay_date, fill.mode)
        _move(session, State.WRITTEN)
        event = _record_turn(session, "naive", text, stt_meta, latency_ms, {
            "decision": "naive_write",
            "commit": result,
            "slots": fill.as_dict(),
        })
        return {
            "session": session,
            "transcript": text,
            "prompt": (
                f"Note kar liya: {fill.amount_inr} rupaye, {fill.pay_date}, {fill.mode}. "
                "(naive path: no read-back)"
            ),
            "commit": result,
            "event": event,
        }
    event = _record_turn(session, "naive", text, stt_meta, latency_ms, {
        "decision": "naive_incomplete",
        "slots": fill.as_dict(),
    })
    return {
        "session": session,
        "transcript": text,
        "prompt": "Amount, date aur payment mode boliye.",
        "event": event,
    }


def _layer_turn(
    session: dict[str, Any],
    text: str,
    verbatim: str | None,
    stt_meta: dict[str, Any],
    latency_ms: int,
) -> dict[str, Any]:
    # Yes / no during confirmation
    if session["state"] == State.CONFIRMING.value:
        lowered = text.lower()
        yes = text_is_confirmation(lowered)
        no = any(w in lowered for w in ("nahi", "galat", "no", "wrong", "नहीं", "गलत"))
        if yes and not no:
            slots = session["slots"]
            result = ledger.commit(session["id"], slots["amount_inr"], slots["pay_date"], slots["mode"])
            _move(session, State.WRITTEN)
            event = _record_turn(session, "layer", text, stt_meta, latency_ms, {
                "decision": "confirmed_write",
                "commit": result,
            })
            return {
                "session": session,
                "transcript": text,
                "prompt": (
                    f"Promise likh diya: {slots['amount_inr']} rupaye, "
                    f"{slots['pay_date']}, {slots['mode']}."
                ),
                "commit": result,
                "event": event,
            }
        if no:
            session["slots"] = {}
            session["pending"] = []
            _move(session, State.CLARIFY)
            _move(session, State.COLLECTING)
            event = _record_turn(session, "layer", text, stt_meta, latency_ms, {"decision": "correction_requested"})
            return {
                "session": session,
                "transcript": text,
                "prompt": "Theek hai, sahi figures ek baar phir boliye: kitne rupaye, kab, kaise?",
                "event": event,
            }

    verdict = assess(text, verbatim_text=verbatim, require_confirm_always=True)
    if session["state"] == State.CLARIFY.value:
        for name in ("amount_inr", "pay_date", "mode"):
            if verdict["slots"][name] is None and session["slots"].get(name) is not None:
                verdict["slots"][name] = session["slots"][name]
                verdict["decisions"][name]["value"] = session["slots"][name]
                if name in verdict["missing"]:
                    verdict["missing"].remove(name)
                if name not in verdict["pending_confirm"]:
                    verdict["pending_confirm"].append(name)
    session["slots"] = verdict["slots"]
    session["pending"] = verdict["pending_confirm"]

    if verdict["missing"]:
        if session["state"] != State.CLARIFY.value:
            _move(session, State.CLARIFY)
        if verdict["slots"]["date_note"] == "kal_ambiguous":
            prompt = "Kal ka matlab clear nahi hai. Kripya exact tareekh DD/MM/YYYY mein batayiye."
        else:
            names = {"amount_inr": "amount", "pay_date": "tareekh", "mode": "payment mode"}
            prompt = "Kripya " + ", ".join(names[x] for x in verdict["missing"]) + " batayiye."
        event = _record_turn(session, "layer", text, stt_meta, latency_ms, {
            "decision": "need_more_slots",
            "verdict": verdict,
        })
        return {"session": session, "transcript": text, "prompt": prompt, "verdict": verdict, "event": event}

    _move(session, State.CONFIRMING)
    prompt = readback_prompt(verdict["decisions"])
    event = _record_turn(session, "layer", text, stt_meta, latency_ms, {
        "decision": "readback",
        "verdict": verdict,
    })
    return {"session": session, "transcript": text, "prompt": prompt, "verdict": verdict, "event": event}


def text_is_confirmation(text: str) -> bool:
    import re
    return bool(re.search(r"\b(haan|han|yes|sahi|theek|ok|okay)\b|हाँ|हां", text.lower())) and not bool(re.search(r"\b(nahi|galat|no|wrong)\b|नहीं|गलत", text.lower()))


def _record_turn(
    session: dict[str, Any],
    mode: str,
    transcript: str,
    stt_meta: dict[str, Any],
    latency_ms: int,
    extra: dict[str, Any],
) -> dict[str, Any]:
    row = {
        "session_id": session["id"],
        "state": session["state"],
        "mode": mode,
        "transcript": transcript,
        "stt": {
            "confidence": None,
            "note": "Prisma REST/stream do not return usable confidence; batch samples show null.",
            "meta": stt_meta,
        },
        "latency_ms": latency_ms,
        **extra,
    }
    session["turns"].append(row)
    turn_log.record(**row)
    return row


class ConfirmBody(BaseModel):
    session_id: str
    accepted: bool


@app.post("/api/confirm")
def confirm(body: ConfirmBody) -> dict[str, Any]:
    # Typed shortcut for the UI buttons; same path as a spoken haan / nahi.
    said = "haan" if body.accepted else "nahi, galat hai"
    return turn_text(TextTurn(session_id=body.session_id, transcript=said, mode="layer"))


@app.get("/api/session/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "unknown session")
    return {"session": session, "log": [e for e in turn_log.events if e.get("session_id") == session_id]}


@app.get("/api/ledger")
def get_ledger() -> dict[str, Any]:
    return {"rows": ledger.rows}


@app.get("/api/eval")
def run_eval() -> dict[str, Any]:
    import json

    path = ROOT / "fixtures" / "eval_cases.json"
    cases = json.loads(path.read_text(encoding="utf-8"))
    naive_ok = 0
    layer_ok = 0
    details = []
    today = date.fromisoformat(cases["today"])
    for case in cases["cases"]:
        gold = case["gold"]
        naive_fill = extract_slots(case["naive_transcript"], today=today)
        naive_triple = (
            naive_fill.amount_inr == gold["amount_inr"]
            and naive_fill.pay_date == gold["pay_date"]
            and naive_fill.mode == gold["mode"]
        )
        # Naive writes immediately if it parsed anything resembling a triple,
        # even when the amount is wrong. Accuracy is whether that write matches gold.
        wrote_naive = bool(naive_fill.amount_inr and naive_fill.pay_date and naive_fill.mode)
        naive_correct = wrote_naive and naive_triple
        if naive_correct:
            naive_ok += 1

        verdict = assess(case["layer_transcript"], today=today, require_confirm_always=True)
        slots = verdict["slots"]
        parsed_ok = (
            slots["amount_inr"] == gold["amount_inr"]
            and slots["pay_date"] == gold["pay_date"]
            and slots["mode"] == gold["mode"]
        )
        # Layer only scores if it would ask for confirmation (never silent-write)
        # and the parsed slots match gold. The user saying "haan" is simulated.
        layer_correct = parsed_ok and bool(verdict["pending_confirm"]) and not verdict["missing"]
        if layer_correct:
            layer_ok += 1
        details.append({
            "id": case["id"],
            "note": case["note"],
            "gold": gold,
            "naive": naive_fill.as_dict(),
            "naive_correct": naive_correct,
            "layer": slots,
            "layer_correct": layer_correct,
            "would_confirm": verdict["pending_confirm"],
        })
    n = len(cases["cases"])
    return {
        "n": n,
        "naive_slot_accuracy": round(naive_ok / n, 3) if n else 0,
        "layer_slot_accuracy": round(layer_ok / n, 3) if n else 0,
        "naive_correct": naive_ok,
        "layer_correct": layer_ok,
        "details": details,
        "policy": cases["policy"],
    }


@app.get("/api/tts")
def tts(text: str) -> Response:
    audio, meta = synthesize(text)
    if not audio:
        raise HTTPException(502, meta)
    return Response(content=audio, media_type="audio/wav", headers={"X-TTS-Voice": str(meta.get("voice"))})


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "has_api_key": bool(os.getenv("GNANI_API_KEY")),
        "sessions": len(sessions),
        "ledger": len(ledger.rows),
    }


@app.websocket("/api/live/{session_id}")
async def live(session_id: str, websocket: WebSocket) -> None:
    from streaming import live_socket
    await live_socket(websocket, session_id)


# Vite copies public worklet assets to the root of dist. Keep this mount last so
# REST and WebSocket routes continue to take precedence over frontend files.
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
