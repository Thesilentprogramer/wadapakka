"""Extract PTP slots from a transcript using the normalizer.

An optional LLM hook can be added later; the default path is deterministic
so the demo still works without a second API key.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date

from normalizer import parse_amount_inr, parse_mode, parse_relative_date


CRITICAL_SLOTS = ("amount_inr", "pay_date", "mode", "name", "phone")


@dataclass
class SlotFill:
    amount_inr: float | None = None
    amount_note: str = ""
    pay_date: str | None = None
    date_note: str = ""
    mode: str | None = None
    mode_note: str = ""
    name: str | None = None
    phone: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def extract_slots(transcript: str, today: date | None = None) -> SlotFill:
    amount, amount_note = parse_amount_inr(transcript)
    when, date_note = parse_relative_date(transcript, today=today)
    mode, mode_note = parse_mode(transcript)
    phone = None
    m = __import__("re").search(r"\b(\d{10})\b", transcript)
    if m:
        phone = m.group(1)
    return SlotFill(
        amount_inr=amount,
        amount_note=amount_note,
        pay_date=when.isoformat() if when else None,
        date_note=date_note,
        mode=mode,
        mode_note=mode_note,
        phone=phone,
    )
