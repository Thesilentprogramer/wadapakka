"""Detect a request for a human, or distress, and build a one-line brief.

This is application-level barge-in / handoff detection. Prisma streaming can
emit a speech_start event when voice is detected; stopping Timbre playback is
the app's job, not a Gnani API.
"""

from __future__ import annotations

import re

HANDOFF_PATTERNS = [
    r"insaan",
    r"insan",
    r"human",
    r"agent se baat",
    r"operator",
    r"supervisor",
    r"kisi se baat",
    r"मुझे किसी इंसान",
    r"इंसान से बात",
    r"complaint",
    r"shikayat",
    r"शिकायत",
]

DISTRESS_PATTERNS = [
    r"ghabra",
    r"dard",
    r"police",
    r"arrest",
    r"threat",
    r"डरा",
]


def detect_handoff(transcript: str) -> dict:
    raw = transcript.lower()
    for pat in HANDOFF_PATTERNS:
        if re.search(pat, raw, flags=re.IGNORECASE):
            return {"handoff": True, "reason": "human_requested", "pattern": pat}
    for pat in DISTRESS_PATTERNS:
        if re.search(pat, raw, flags=re.IGNORECASE):
            return {"handoff": True, "reason": "distress", "pattern": pat}
    return {"handoff": False, "reason": None, "pattern": None}


def brief(slots: dict, transcript: str, reason: str) -> str:
    transcript = " ".join(transcript.split())[:180]
    amount = slots.get("amount_inr")
    when = slots.get("pay_date")
    mode = slots.get("mode")
    return (
        f"Handoff ({reason}). Last line: {transcript!r}. "
        f"Slots so far: amount={amount}, date={when}, mode={mode}."
    )
