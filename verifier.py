"""Decide whether a critical slot can be trusted.

Prisma REST and streaming responses do not include a usable ASR confidence
score. Official batch samples include a `confidence` field that is `null`.
There is no documented n-best list.

This module therefore never "reads" model confidence. It invents a
trust decision from:
  1. Can the Indic normalizer parse a single unambiguous value?
  2. Do format=transcribe and format=verbatim agree after normalisation?
  3. Is the value plausible (positive amount, date not in the past, known mode)?
  4. If still untrusted, ask for a targeted Timbre read-back.

When dual-pass is skipped (single REST call for latency), every critical
slot that we are about to write is confirmed by read-back. That is the
honest fallback.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from normalizer import parse_amount_inr, parse_mode, parse_relative_date
from slots import CRITICAL_SLOTS, SlotFill, extract_slots


def _amounts_agree(a: float | None, b: float | None) -> bool:
    if a is None or b is None:
        return False
    return abs(a - b) < 0.01


def assess(
    transcribe_text: str,
    verbatim_text: str | None = None,
    today: date | None = None,
    require_confirm_always: bool = True,
) -> dict[str, Any]:
    primary = extract_slots(transcribe_text, today=today)
    secondary = extract_slots(verbatim_text, today=today) if verbatim_text else None

    decisions: dict[str, Any] = {}
    # Amount
    amount_ok = primary.amount_inr is not None and primary.amount_inr > 0
    if secondary:
        amount_ok = amount_ok and _amounts_agree(primary.amount_inr, secondary.amount_inr)
    decisions["amount_inr"] = {
        "value": primary.amount_inr,
        "trusted": bool(amount_ok) and not require_confirm_always,
        "needs_confirm": require_confirm_always or not amount_ok,
        "reason": _reason(amount_ok, primary.amount_note, secondary.amount_note if secondary else None),
    }
    # Date
    anchor = today or date.today()
    date_ok = primary.pay_date is not None and primary.date_note != "kal_ambiguous" and primary.pay_date >= anchor.isoformat()
    if secondary:
        date_ok = date_ok and primary.pay_date == secondary.pay_date
    if primary.date_note == "kal_ambiguous":
        date_ok = False
    decisions["pay_date"] = {
        "value": primary.pay_date,
        "trusted": bool(date_ok) and not require_confirm_always,
        "needs_confirm": require_confirm_always or not date_ok,
        "reason": _reason(date_ok, primary.date_note, secondary.date_note if secondary else None),
    }
    # Mode
    mode_ok = primary.mode is not None
    if secondary:
        mode_ok = mode_ok and primary.mode == secondary.mode
    decisions["mode"] = {
        "value": primary.mode,
        "trusted": bool(mode_ok) and not require_confirm_always,
        "needs_confirm": require_confirm_always or not mode_ok,
        "reason": _reason(mode_ok, primary.mode_note, secondary.mode_note if secondary else None),
    }

    pending = [name for name, d in decisions.items() if d["needs_confirm"] and d["value"] is not None]
    missing = [name for name, d in decisions.items() if d["value"] is None or (name == "pay_date" and not date_ok and primary.date_note in {"kal_ambiguous", "numeric_date", "invalid_numeric_date"})]
    return {
        "slots": primary.as_dict(),
        "decisions": decisions,
        "pending_confirm": pending,
        "missing": missing,
        "policy": (
            "confirm_every_critical_slot"
            if require_confirm_always
            else "confirm_when_dual_pass_disagrees_or_implausible"
        ),
        "note": (
            "Prisma does not expose usable ASR confidence or n-best. "
            "Trust here is dual-pass agreement plus normalizer plausibility."
        ),
        "critical_slots": list(CRITICAL_SLOTS),
    }


def _reason(ok: bool, note: str, other: str | None) -> str:
    if other and other != note:
        return f"{note}; dual_pass_other={other}; agree={ok}"
    return note if ok else f"untrusted:{note}"


def readback_prompt(decisions: dict[str, Any]) -> str:
    parts = []
    amount = decisions.get("amount_inr", {}).get("value")
    when = decisions.get("pay_date", {}).get("value")
    mode = decisions.get("mode", {}).get("value")
    if amount is not None:
        parts.append(f"{int(amount)} rupaye")
    if when:
        parts.append(f"tareekh {when}")
    if mode:
        parts.append(f"mode {mode}")
    if not parts:
        return "Main samajh nahi paayi. Kitne rupaye, kab, aur kaise bharenge? Ek baar clearly boliye."
    joined = ", ".join(parts)
    return f"Confirm karne ke liye boliye haan. Maine note kiya: {joined}. Galat ho to sahi figures boliye."
