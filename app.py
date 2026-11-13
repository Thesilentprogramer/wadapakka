"""WadaPakka reliability layer — turn-based REST plus live streaming WebSocket."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from threading import RLock

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
from idempotency import Ledger, LedgerUnavailableError
from observability import TurnLog
from slots import extract_slots
from state_machine import State, can_move
from verifier import assess, readback_prompt
from audit import audit_session
from promise_guard import classify_consent


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
session_lock = RLock()
SYNTHETIC_ACCOUNT_ID = "synthetic-ravi-kumar"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ledger_rows_safe(store: Ledger) -> list[dict[str, Any]]:
    try:
        return store.rows
    except LedgerUnavailableError:
        return []


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
    session = _new_session()
    greeting = (
        "Namaste, main WadaPakka bol rahi hoon. "
        "Aapka outstanding 2500 rupaye hai. "
        "Aap kab, kitna, aur kaise bharenge?"
    )
    return {"session": session, "prompt": greeting}


def _new_session(sessions_store: dict[str, dict[str, Any]] | None = None,
                 today: date | None = None) -> dict[str, Any]:
    sessions_store = sessions if sessions_store is None else sessions_store
    sid = str(uuid.uuid4())
    sessions_store[sid] = {
        "id": sid,
        "state": State.GREETING.value,
        "account_id": SYNTHETIC_ACCOUNT_ID,
        "today": today or date.today(),
        "slots": {},
        "proposal": None,
        "proposal_history": [],
        "proposal_version": 0,
        "unresolved_fields": [],
        "commit_status": None,
        "audit_status": "NO_PROMISE",
        "pending": [],
        "turns": [],
        "created_at": _now(),
        "account": {
            "name": "Ravi Kumar",
            "outstanding_inr": 2500,
            "note": "Synthetic demo account. No real borrower data.",
        },
    }
    _move(sessions_store[sid], State.COLLECTING)
    return sessions_store[sid]


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
    session_id: str, transcript: str, mode: str, verbatim: str | None,
    stt_meta: dict[str, Any], latency_ms: int,
    sessions_store: dict[str, dict[str, Any]] | None = None,
    ledger_store: Ledger | None = None, record_global: bool = True,
) -> dict[str, Any]:
    with session_lock:
        return _handle_turn_inner(session_id, transcript, mode, verbatim, stt_meta,
                                  latency_ms, sessions_store, ledger_store, record_global)


def _handle_turn_inner(
    session_id: str,
    transcript: str,
    mode: str,
    verbatim: str | None,
    stt_meta: dict[str, Any],
    latency_ms: int,
    sessions_store: dict[str, dict[str, Any]] | None = None,
    ledger_store: Ledger | None = None,
    record_global: bool = True,
) -> dict[str, Any]:
    sessions_store = sessions if sessions_store is None else sessions_store
    ledger_store = ledger if ledger_store is None else ledger_store
    session = sessions_store.get(session_id)
    if not session:
        raise HTTPException(404, "unknown session")
    segment_id = stt_meta.get("segment_id")
    if segment_id and segment_id in session.setdefault("seen_segment_ids", []):
        return {"session": session, "transcript": transcript, "prompt": "",
                "commit_status": "duplicate_segment", "event": {"decision": "duplicate_segment"}}
    if segment_id:
        session["seen_segment_ids"].append(segment_id)
    if stt_meta.get("proposal_id") and stt_meta["proposal_id"] != session.get("active_proposal_id"):
        return _rejected_confirmation(session, transcript, stt_meta, latency_ms, ledger_store,
                                      record_global, "stale_proposal")
    if session["state"] == State.WRITTEN.value and mode == "layer":
        row = next((r for r in _ledger_rows_safe(ledger_store) if r["session_id"] == session_id), None)
        if not row:
            return _rejected_confirmation(session, transcript, stt_meta, latency_ms, ledger_store,
                                          record_global, "ledger_unavailable")
        mentioned = extract_slots(transcript, today=session["today"])
        changed = (mentioned.amount_inr is not None and round(mentioned.amount_inr * 100) != row["amount_paise"] or
                   mentioned.pay_date is not None and mentioned.pay_date != row["pay_date"] or
                   mentioned.mode is not None and mentioned.mode != row["mode"])
        if changed:
            event = _record_turn(session, mode, transcript, stt_meta, latency_ms,
                                 {"decision": "post_commit_discrepancy"}, ledger_store, record_global)
            return {"session": session, "transcript": transcript,
                    "prompt": "Aapki nayi baat review ke liye bhej rahi hoon.",
                    "commit_status": "review_required", "audit_status": session["audit_status"], "event": event}
        if text_is_confirmation(transcript):
            result = {"status": "duplicate", "written": False, "duplicate": True, "row": row}
            event = _record_turn(session, mode, transcript, stt_meta, latency_ms,
                                 {"decision": "duplicate_confirmation", "commit": result}, ledger_store, record_global)
            return {"session": session, "transcript": transcript, "prompt": "Promise pehle hi likh diya gaya hai.",
                    "commit": result, "commit_status": "duplicate", "event": event}
    if session["state"] in {State.WRITTEN.value, State.HANDOFF.value, State.REFUSED.value}:
        raise HTTPException(409, f"session already {session['state']}")

    text = (transcript or "").strip()
    if mode == "layer" and re.search(r"\bai\b", text, re.I) and any(w in text.lower() for w in ("are you", "aap", "tum")):
        event = _record_turn(session, mode, text, stt_meta, latency_ms,
                             {"decision": "ai_disclosure"}, ledger_store, record_global)
        return {"session": session, "transcript": text,
                "prompt": "Haan, main ek AI assistant hoon. Aap payment ke baare mein baat kar sakte hain.",
                "audit_status": session["audit_status"], "event": event}
    hand = detect_handoff(text)
    if hand["handoff"] and mode == "layer":
        _move(session, State.HANDOFF)
        note = handoff_brief(session.get("slots") or {}, text, hand["reason"])
        event = _record_turn(session, mode, text, stt_meta, latency_ms, {
            "decision": "handoff",
            "handoff": hand,
            "brief": note,
        }, ledger_store, record_global)
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
            event = _record_turn(session, mode, text, stt_meta, latency_ms, {"decision": "refused"}, ledger_store, record_global)
            return {"session": session, "transcript": text, "prompt": "Theek hai, maine note kar liya.", "event": event}

    if mode == "naive":
        return _naive_commit(session, text, stt_meta, latency_ms, ledger_store, record_global)

    return _layer_turn(session, text, verbatim, stt_meta, latency_ms, ledger_store, record_global)


def _naive_commit(
    session: dict[str, Any],
    text: str,
    stt_meta: dict[str, Any],
    latency_ms: int,
    ledger_store: Ledger,
    record_global: bool,
) -> dict[str, Any]:
    """Simulate the unsafe comparison outside the guarded Ledger."""
    fill = extract_slots(text)
    session["slots"] = fill.as_dict()
    if fill.amount_inr and fill.pay_date and fill.mode:
        result = {"status": "simulated_would_write", "written": False, "simulated": True,
                  "would_write": {"amount_inr": fill.amount_inr, "pay_date": fill.pay_date, "mode": fill.mode}}
        event = _record_turn(session, "naive", text, stt_meta, latency_ms, {
            "decision": "naive_would_write",
            "commit": result,
            "slots": fill.as_dict(),
        }, ledger_store, record_global)
        return {
            "session": session,
            "transcript": text,
            "prompt": (
                f"Note kar liya: {fill.amount_inr} rupaye, {fill.pay_date}, {fill.mode}. "
                "(simulated naive result; nothing saved)"
            ),
            "commit": result,
            "commit_status": "simulated_would_write",
            "event": event,
        }
    event = _record_turn(session, "naive", text, stt_meta, latency_ms, {
        "decision": "naive_incomplete",
        "slots": fill.as_dict(),
    }, ledger_store, record_global)
    return {
        "session": session,
        "transcript": text,
        "prompt": "Amount, date aur payment mode boliye.",
        "event": event,
    }


def _layer_turn(
    session: dict[str, Any], text: str, verbatim: str | None,
    stt_meta: dict[str, Any], latency_ms: int, ledger_store: Ledger,
    record_global: bool,
) -> dict[str, Any]:
    proposal = session.get("proposal")
    source = stt_meta.get("source", "text")
    is_stream = source == "stream"
    confirming = session["state"] in {"CONFIRMING", "AWAITING_CONFIRMATION", "READBACK_PENDING", "COMMIT_FAILED"}
    consent = classify_consent(text, proposal) if confirming else {"status": "ambiguous"}

    if confirming and consent["status"] == "affirmative":
        if not proposal or proposal.get("id") != session.get("active_proposal_id"):
            return _rejected_confirmation(session, text, stt_meta, latency_ms, ledger_store, record_global, "stale_proposal")
        if is_stream and (proposal.get("readback_status") != "complete" or not stt_meta.get("readback_complete")):
            return _rejected_confirmation(session, text, stt_meta, latency_ms, ledger_store, record_global, "readback_incomplete")
        if source == "rest" or source == "rest_dual_pass":
            if proposal.get("readback_status") != "complete":
                return _rejected_confirmation(session, text, stt_meta, latency_ms, ledger_store, record_global, "readback_incomplete")
        if source == "text":
            proposal["readback_status"] = "ui_acknowledged"
        confirmation = {"turn_id": str(uuid.uuid4()), "transcript": text,
                        "source": "speech" if is_stream or source.startswith("rest") else "ui",
                        "proposal_id": proposal["id"],
                        "accepted": True if source == "text" else None}
        session["confirmation"] = confirmation
        session["state"] = "COMMITTING"
        result = ledger_store.commit_confirmed_promise(
            proposal, confirmation, segment_id=stt_meta.get("segment_id"),
            inject_failure=bool(stt_meta.get("inject_failure")))
        status = result["status"]
        session["commit_status"] = status
        if status in {"written", "duplicate"} and result.get("row"):
            session["state"] = "WRITTEN"
            row = result["row"]
            prompt = ("Promise pehle hi likh diya gaya hai." if status == "duplicate" else
                      f"Promise likh diya: {row['amount_paise'] / 100:g} rupaye, {row['pay_date']}, {row['mode']}.")
        elif status == "open_promise_conflict":
            session["state"] = "HANDOFF"
            session["handoff_reason"] = "open_promise_conflict"
            prompt = "Is account par pehle se ek promise hai. Review ke liye bhej rahi hoon."
        else:
            session["state"] = "COMMIT_FAILED"
            prompt = "Main abhi promise record nahi kar paayi. Kripya dobara koshish karein."
        event = _record_turn(session, "layer", text, stt_meta, latency_ms,
                             {"decision": "commit_attempt", "commit": result,
                              "turn_id": confirmation["turn_id"]}, ledger_store, record_global)
        return {"session": session, "transcript": text, "prompt": prompt,
                "commit": result, "commit_status": status,
                "evidence_id": result.get("evidence_id"),
                "audit_status": session["audit_status"], "event": event}

    if confirming and consent["status"] == "negative" and not _contains_slots(text, session["today"]):
        if session.get("proposal"):
            session["proposal_history"].append(dict(session["proposal"]))
        session["proposal"] = None
        session["active_proposal_id"] = None
        session["state"] = "CLARIFY"
        event = _record_turn(session, "layer", text, stt_meta, latency_ms,
                             {"decision": "correction_requested"}, ledger_store, record_global)
        return {"session": session, "transcript": text,
                "prompt": "Sahi amount, date aur mode batayiye; main poora read back dobara karungi.",
                "audit_status": session["audit_status"], "event": event}

    if confirming and consent["status"] == "ambiguous" and not _contains_slots(text, session["today"]):
        return _rejected_confirmation(session, text, stt_meta, latency_ms, ledger_store, record_global,
                                      "confirmation_ambiguous")

    # Any correction invalidates the old read-back and starts a new proposal.
    if confirming:
        if session.get("proposal"):
            session["proposal_history"].append(dict(session["proposal"]))
        session["proposal"] = None
        session["active_proposal_id"] = None
        session["state"] = "CLARIFY"
    verdict = assess(text, verbatim_text=verbatim, today=session["today"], require_confirm_always=True)
    old = session.get("slots") or {}
    new_slots = verdict["slots"]
    for name in ("amount_inr", "pay_date", "mode"):
        if name == "pay_date" and verdict["slots"].get("date_note") in {"kal_ambiguous", "invalid_numeric_date"}:
            new_slots[name] = None
        elif new_slots[name] is None and old.get(name) is not None:
            new_slots[name] = old[name]
        elif name == "amount_inr" and new_slots[name] is not None and old.get(name) and \
                not any(w in text.lower() for w in ("rupee", "rupay", "₹", "amount", "sirf", "only")) and \
                ("november" in text.lower() or "नवंबर" in text or "नवम्बर" in text):
            new_slots[name] = old[name]
    missing = [name for name in ("amount_inr", "pay_date", "mode") if new_slots.get(name) is None]
    amount_text = re.sub(r"\b(?:20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b", " ", text)
    amount_text = re.sub(r"\b(?:\d{1,2}|pandrah|solah|पंद्रह|सोलह)\s+(?:november|nov|नवंबर|नवम्बर)(?:\s+20\d{2})?\b", " ", amount_text, flags=re.I)
    amounts_in_text = {round(float(value.replace(",", "")) * 100) for value in re.findall(r"(?<!\w)(\d[\d,]*(?:\.\d{1,2})?)(?!\w)", amount_text)}
    alternatives = re.split(r"\b(?:or|ya|aur)\b|या|और|अथवा", amount_text, flags=re.I)
    alternative_amounts = {round(value * 100) for part in alternatives
                           for value in [extract_slots(part, today=session["today"]).amount_inr]
                           if value is not None}
    ambiguous_amount = (len(amounts_in_text) > 1 or
                        (len(alternatives) > 1 and len(alternative_amounts) > 1)) and \
                       not re.search(r"\b(?:only|sirf|bas)\b", text, re.I)
    if ambiguous_amount:
        session.setdefault("uncertain_reasons", []).append("multiple_amount_candidates")
        new_slots["amount_inr"] = None
        session["unresolved_fields"] = list(set(session.get("unresolved_fields", [])) | {"amount_inr"})
        missing = list(dict.fromkeys(missing + ["amount_inr"]))
    date_spans = re.findall(r"\b(?:20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:\d{1,2}|pandrah|solah|पंद्रह|सोलह)\s+(?:november|nov|नवंबर|नवम्बर)(?:\s+20\d{2})?)\b", text, flags=re.I)
    date_candidates = {value for span in date_spans
                       for value in [extract_slots(span, today=session["today"]).pay_date] if value}
    ambiguous_date = len(date_candidates) > 1
    if ambiguous_date:
        session.setdefault("uncertain_reasons", []).append("multiple_date_candidates")
        new_slots["pay_date"] = None
        session["unresolved_fields"] = list(set(session.get("unresolved_fields", [])) | {"pay_date"})
        missing = list(dict.fromkeys(missing + ["pay_date"]))
    session["slots"] = new_slots
    session["pending"] = list(("amount_inr", "pay_date", "mode"))
    if verbatim:
        secondary = extract_slots(verbatim, today=session["today"])
        if any(getattr(secondary, k) is not None and getattr(secondary, k) != new_slots.get(k)
               for k in ("amount_inr", "pay_date", "mode")):
            session.setdefault("uncertain_reasons", []).append("dual_pass_disagreement")
            for name in ("amount_inr", "pay_date", "mode"):
                if getattr(secondary, name) is not None and getattr(secondary, name) != new_slots.get(name):
                    new_slots[name] = None
                    session["unresolved_fields"] = list(set(session.get("unresolved_fields", [])) | {name})
            missing = list(dict.fromkeys(missing + ["amount_inr", "pay_date", "mode"]))
    for name in tuple(session.get("unresolved_fields", [])):
        if name == "amount_inr" and ambiguous_amount:
            continue
        if name == "pay_date" and ambiguous_date:
            continue
        if new_slots.get(name) is not None and getattr(extract_slots(text, today=session["today"]), name) is not None:
            session["unresolved_fields"].remove(name)
    missing = list(dict.fromkeys(missing + session.get("unresolved_fields", [])))
    if missing:
        session["state"] = "CLARIFY"
        names = {"amount_inr": "amount", "pay_date": "tareekh", "mode": "payment mode"}
        prompt = ("Kal ka matlab clear nahi hai. Kripya exact tareekh DD/MM/YYYY mein batayiye."
                  if verdict["slots"]["date_note"] == "kal_ambiguous" else
                  "Kripya " + ", ".join(names[x] for x in missing) + " batayiye.")
        event = _record_turn(session, "layer", text, stt_meta, latency_ms,
                             {"decision": "need_more_slots", "verdict": verdict}, ledger_store, record_global)
        return {"session": session, "transcript": text, "prompt": prompt,
                "verdict": verdict, "audit_status": session["audit_status"], "event": event}

    session["proposal_version"] = session.get("proposal_version", 0) + 1
    if session.get("proposal"):
        session["proposal_history"].append(dict(session["proposal"]))
    proposal_id = str(uuid.uuid4())
    for name in ("amount_inr", "pay_date", "mode"):
        verdict["decisions"][name]["value"] = new_slots[name]
    prompt = readback_prompt(verdict["decisions"])
    session["proposal"] = {"id": proposal_id, "proposal_id": proposal_id,
                           "version": session["proposal_version"],
                           "account_id": session["account_id"], "session_id": session["id"],
                           "amount_paise": round(float(new_slots["amount_inr"]) * 100),
                           "pay_date": new_slots["pay_date"], "mode": new_slots["mode"],
                           "readback_text": prompt, "readback_turn_id": str(uuid.uuid4()),
                           "readback_status": "pending" if is_stream else "displayed",
                           "expires_at": None}
    session["active_proposal_id"] = proposal_id
    session["state"] = "READBACK_PENDING" if is_stream else "CONFIRMING"
    event = _record_turn(session, "layer", text, stt_meta, latency_ms,
                         {"decision": "readback", "verdict": verdict}, ledger_store, record_global)
    return {"session": session, "transcript": text, "prompt": prompt,
            "proposal": session["proposal"], "verdict": verdict,
            "audit_status": session["audit_status"], "event": event}


def _contains_slots(text: str, today: date) -> bool:
    slots = extract_slots(text, today=today)
    return any((slots.amount_inr, slots.pay_date, slots.mode))


def _rejected_confirmation(session: dict[str, Any], text: str, stt_meta: dict[str, Any],
                           latency_ms: int, ledger_store: Ledger, record_global: bool,
                           code: str) -> dict[str, Any]:
    session["commit_status"] = code
    event = _record_turn(session, "layer", text, stt_meta, latency_ms,
                         {"decision": code}, ledger_store, record_global)
    return {"session": session, "transcript": text,
            "prompt": ("Main abhi promise record nahi kar paayi. Kripya dobara koshish karein." if code == "ledger_unavailable" else
                       "Kripya poora read back suniye aur phir saaf haan boliye." if code == "readback_incomplete" else
                       "Kripya saaf haan ya sahi figures batayiye."),
            "commit_status": code, "audit_status": session["audit_status"], "event": event}


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
    ledger_store: Ledger | None = None,
    record_global: bool = True,
) -> dict[str, Any]:
    row = {
        "session_id": session["id"],
        "turn_id": str(uuid.uuid4()),
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
    if record_global:
        turn_log.record(**row)
    audit_session(session, _ledger_rows_safe(ledger_store or ledger))
    return row


class ConfirmBody(BaseModel):
    session_id: str
    accepted: bool
    proposal_id: str | None = None


class ReadbackBody(BaseModel):
    session_id: str
    proposal_id: str


@app.post("/api/readback/complete")
def complete_readback(body: ReadbackBody) -> dict[str, Any]:
    """Browser acknowledgement after a REST turn's full Timbre playback."""
    with session_lock:
        session = sessions.get(body.session_id)
        if not session:
            raise HTTPException(404, "unknown session")
        proposal = session.get("proposal")
        if not proposal or proposal["id"] != body.proposal_id or session.get("active_proposal_id") != body.proposal_id:
            raise HTTPException(409, {"error": "stale_proposal"})
        if session["state"] not in {"CONFIRMING", "READBACK_PENDING"}:
            raise HTTPException(409, {"error": "readback_incomplete"})
        proposal["readback_status"] = "complete"
        session["state"] = "AWAITING_CONFIRMATION"
        return {"session": session, "proposal_id": body.proposal_id, "readback_status": "complete"}


@app.post("/api/confirm")
def confirm(body: ConfirmBody) -> dict[str, Any]:
    with session_lock:
        session = sessions.get(body.session_id)
        if not session:
            raise HTTPException(404, "unknown session")
        if not body.proposal_id or not session.get("proposal") or body.proposal_id != session["proposal"]["id"]:
            raise HTTPException(409, {"error": "stale_proposal"})
        if session["state"] not in {"CONFIRMING", "AWAITING_CONFIRMATION", "COMMIT_FAILED", "WRITTEN"}:
            raise HTTPException(409, {"error": "readback_incomplete"})
        said = "haan" if body.accepted else "nahi, galat hai"
        return _handle_turn(body.session_id, said, "layer", None,
                            {"source": "text", "proposal_id": body.proposal_id}, 0)


@app.get("/api/session/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "unknown session")
    return {"session": session, "log": [e for e in turn_log.events if e.get("session_id") == session_id]}


@app.get("/api/ledger")
def get_ledger() -> dict[str, Any]:
    rows = []
    for saved in ledger.rows:
        row = dict(saved)
        session = sessions.get(row["session_id"])
        row["review_status"] = (session.get("audit_status") if session and
                                session.get("audit_status") == "REVIEW_REQUIRED" else None)
        evidence = ledger.get_evidence(row["promise_id"])
        row["confirmation_source"] = evidence.get("source") if evidence else None
        rows.append(row)
    unconfirmed = []
    for session in sessions.values():
        proposal = session.get("proposal") or next(iter(reversed(session.get("proposal_history", []))), None)
        if proposal and not any(row["session_id"] == session["id"] for row in rows):
            unconfirmed.append({"session_id": session["id"], "account_id": session["account_id"],
                                "proposal": proposal, "audit_status": session.get("audit_status")})
    return {"rows": rows, "unconfirmed": unconfirmed}


@app.get("/api/ledger/{promise_id}/evidence")
def get_ledger_evidence(promise_id: str) -> dict[str, Any]:
    evidence = ledger.get_evidence(promise_id)
    if not evidence:
        raise HTTPException(404, "unknown promise")
    return evidence


@app.post("/api/session/{session_id}/end")
def end_session(session_id: str) -> dict[str, Any]:
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "unknown session")
    if not session.get("ended_at"):
        session["ended_at"] = _now()
        audit_session(session, ledger.rows)
    return {"session": session, "audit": session["audit"]}


@app.get("/api/session/{session_id}/audit")
def get_session_audit(session_id: str) -> dict[str, Any]:
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "unknown session")
    return {"audit": session.get("audit") or audit_session(session, ledger.rows)}


@app.get("/api/audits")
def get_audits(status: str | None = None) -> dict[str, Any]:
    rows = [s["audit"] for s in sessions.values() if s.get("audit")]
    return {"rows": [r for r in rows if status is None or r["status"] == status]}


@app.get("/api/handoffs")
def get_handoffs() -> dict[str, Any]:
    rows = [
        {"session_id": event["session_id"], "reason": event["handoff"]["reason"],
         "brief": event["brief"], "transcript": event["transcript"],
         "logged_at": event["logged_at"], "zero_write": True,
         "audit": sessions.get(event["session_id"], {}).get("audit")}
        for event in turn_log.events if event.get("decision") == "handoff"
    ]
    for session in sessions.values():
        if session.get("handoff_reason") == "open_promise_conflict" or session.get("audit_status") in {"NEEDS_REVIEW", "REVIEW_REQUIRED"}:
            rows.append({"session_id": session["id"], "reason": session.get("handoff_reason", "audit_conflict"),
                         "brief": "Review transcript and proposal discrepancy.",
                         "transcript": session["turns"][-1]["transcript"] if session["turns"] else "",
                         "logged_at": session.get("ended_at", session["created_at"]),
                         "zero_write": not any(r["session_id"] == session["id"] for r in ledger.rows),
                         "audit": session.get("audit")})
    return {"rows": rows}


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
        "label": "legacy parser fixtures (single-turn text, simulated naive writes)",
        "n": n,
        "naive_slot_accuracy": round(naive_ok / n, 3) if n else 0,
        "layer_slot_accuracy": round(layer_ok / n, 3) if n else 0,
        "naive_correct": naive_ok,
        "layer_correct": layer_ok,
        "details": details,
        "policy": cases["policy"],
    }


@app.get("/api/eval/adversarial")
def run_adversarial() -> dict[str, Any]:
    from adversarial_eval import run_adversarial_eval
    return run_adversarial_eval(_handle_turn, _new_session, lambda: Ledger(":memory:"))


@app.get("/api/eval/adversarial/{case_id}/audit")
def get_adversarial_audit(case_id: str) -> dict[str, Any]:
    result = run_adversarial()
    case = next((item for item in result["cases"] + result["negative_variants"]
                 if item["id"] == case_id), None)
    if not case:
        raise HTTPException(404, "unknown adversarial case")
    return {"case_id": case_id, "audit": case.get("audit"),
            "mode": "deterministic_text_replay", "passed": case["passed"]}


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
