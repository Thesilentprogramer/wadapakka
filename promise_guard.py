"""Canonical promise proposals and rule-based confirmation evidence.

Offsets returned by :func:`classify_consent` are Python string character
offsets (start-inclusive, end-exclusive), never audio timestamps.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Mapping


@dataclass(frozen=True, slots=True)
class PromiseProposal:
    """Immutable canonical values bound to one read-back proposal."""

    proposal_id: str
    version: int
    account_id: str
    session_id: str
    amount_paise: int
    pay_date: str
    mode: str
    readback_text: str
    readback_turn_id: str | None = None
    readback_status: str = "pending"

    @property
    def amount_inr(self) -> float:
        return self.amount_paise / 100

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.proposal_id,
            "proposal_id": self.proposal_id,
            "version": self.version,
            "account_id": self.account_id,
            "session_id": self.session_id,
            "amount_paise": self.amount_paise,
            "amount_inr": self.amount_inr,
            "pay_date": self.pay_date,
            "mode": self.mode,
            "readback_text": self.readback_text,
            "readback_turn_id": self.readback_turn_id,
            "readback_status": self.readback_status,
        }


def freeze_proposal(
    proposal: PromiseProposal | Mapping[str, Any] | None = None,
    **overrides: Any,
) -> PromiseProposal:
    """Return a frozen, normalized proposal from a mapping or keyword fields.

    A fresh object should be created for each correction/read-back version.
    Passing ``proposal_id`` explicitly keeps that identity stable across retries.
    """

    values: dict[str, Any] = {}
    if isinstance(proposal, PromiseProposal):
        values.update(proposal.as_dict())
    elif proposal is not None:
        values.update(dict(proposal))
    values.update(overrides)

    proposal_id = str(values.get("proposal_id") or values.get("id") or uuid.uuid4())
    version = int(values.get("version") or 1)
    account_id = str(values.get("account_id") or "").strip()
    session_id = str(values.get("session_id") or "").strip()

    if values.get("amount_paise") is not None:
        try:
            raw_paise = Decimal(str(values["amount_paise"]))
            amount_paise = int(raw_paise.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        except (InvalidOperation, ValueError, TypeError):
            raise ValueError("amount_paise must be a whole positive number") from None
    else:
        try:
            raw_inr = Decimal(str(values.get("amount_inr")))
            amount_paise = int((raw_inr * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        except (InvalidOperation, ValueError, TypeError):
            raise ValueError("amount_inr must be a positive number") from None

    raw_date = values.get("pay_date")
    try:
        parsed_date = raw_date if isinstance(raw_date, date) else date.fromisoformat(str(raw_date))
        pay_date = parsed_date.isoformat()
    except (TypeError, ValueError):
        raise ValueError("pay_date must be an ISO date") from None

    mode = str(values.get("mode") or "").strip().upper()
    readback_text = str(values.get("readback_text") or "").strip()
    readback_turn_id = values.get("readback_turn_id")
    if readback_turn_id is not None:
        readback_turn_id = str(readback_turn_id)
    readback_status = str(values.get("readback_status") or "pending").strip().lower()

    if not proposal_id or not account_id or not session_id:
        raise ValueError("proposal_id, account_id, and session_id are required")
    if version < 1:
        raise ValueError("version must be positive")
    if amount_paise <= 0:
        raise ValueError("amount_paise must be positive")
    if not mode:
        raise ValueError("mode is required")

    return PromiseProposal(
        proposal_id=proposal_id,
        version=version,
        account_id=account_id,
        session_id=session_id,
        amount_paise=amount_paise,
        pay_date=pay_date,
        mode=mode,
        readback_text=readback_text,
        readback_turn_id=readback_turn_id,
        readback_status=readback_status,
    )


_AFFIRMATIVE_RE = re.compile(
    r"(?<![\w])(?:haan|han|yes|yeah|yep|sahi|theek|thik|ok(?:ay)?|bilkul|"
    r"हाँ|हां|हँ|जी)(?![\w])",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"(?<![\w])(?:nahi|nahin|nhi|no|nope|nah|not|wrong|galat|"
    r"नहीं|नहि|गलत|मत)(?![\w])",
    re.IGNORECASE,
)
_CORRECTION_RE = re.compile(
    r"(?<![\w])(?:but|lekin|magar|par|actually|instead|change|changed|"
    r"correct|correction|wait|hold on|ruk(?:o)?|badal|badli|"
    r"लेकिन|मगर|पर|बदलो|रुको)(?![\w])",
    re.IGNORECASE,
)
_RELATIVE_DATE_RE = re.compile(
    r"(?<![\w])(?:today|tomorrow|aaj|kal|parso|parson|next|agle|agla|"
    r"somvaar|somvar|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"आज|कल|परसों|अगले|अगला|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार)(?![\w])",
    re.IGNORECASE,
)
_EXPLICIT_DATE_RE = re.compile(
    r"(?<!\d)(?:20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|"
    r"\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|"
    r"apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|"
    r"oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|नवंबर|नवम्बर))(?!\d)",
    re.IGNORECASE,
)
_MONTH_WORD_RE = re.compile(
    r"(?<![\w])(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|"
    r"jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|"
    r"nov(?:ember)?|dec(?:ember)?|नवंबर|नवम्बर)(?![\w])",
    re.IGNORECASE,
)
_NUMBER_RE = re.compile(r"(?<![\w])\d[\d,]*(?:\.\d{1,2})?(?![\w])")
_AMOUNT_CONNECTOR_RE = re.compile(
    r"(?<![\w])(?:ya|or|and|aur|या|और|अथवा)(?![\w])",
    re.IGNORECASE,
)
_UPI_MODE_RE = re.compile(r"(?<![\w])(?:upi|yupi)(?![\w])", re.IGNORECASE)
_CASH_MODE_RE = re.compile(r"(?<![\w])(?:cash|nag(?:ad)?)(?![\w])|नकद|कैश", re.IGNORECASE)
_BANK_MODE_RE = re.compile(
    r"(?<![\w])(?:bank|neft|imps|rtgs|transfer)(?![\w])|बैंक|ट्रांसफर",
    re.IGNORECASE,
)


def _proposal_values(proposal: PromiseProposal | Mapping[str, Any] | None) -> dict[str, Any]:
    if proposal is None:
        return {}
    if isinstance(proposal, PromiseProposal):
        return proposal.as_dict()
    return dict(proposal)


def _canonical_amount_paise(values: Mapping[str, Any]) -> int | None:
    try:
        if values.get("amount_paise") is not None:
            return int(Decimal(str(values["amount_paise"])))
        if values.get("amount_inr") is not None:
            return int((Decimal(str(values["amount_inr"])) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, TypeError, ValueError):
        pass
    return None


def _canonical_date(values: Mapping[str, Any]) -> date | None:
    try:
        raw = values.get("pay_date")
        if isinstance(raw, date):
            return raw
        return date.fromisoformat(str(raw))
    except (TypeError, ValueError):
        return None


def _date_is_mentioned(text: str) -> bool:
    return bool(_EXPLICIT_DATE_RE.search(text) or _RELATIVE_DATE_RE.search(text))


def _date_changed(text: str, proposal_date: date) -> bool:
    """Conservatively detect a new or conflicting date in a confirmation."""
    if _RELATIVE_DATE_RE.search(text):
        # Relative words do not carry an anchor in the confirmation itself.
        return True
    from normalizer import parse_relative_date

    explicit_matches = list(_EXPLICIT_DATE_RE.finditer(text))
    if not explicit_matches:
        return False

    months = {
        "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
        "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7,
        "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
        "september": 9, "oct": 10, "october": 10, "nov": 11,
        "november": 11, "dec": 12, "december": 12,
    }
    candidates: list[date] = []
    for match in explicit_matches:
        date_text = match.group(0)
        parsed, _note = parse_relative_date(date_text, today=proposal_date)
        if parsed is None and _MONTH_WORD_RE.search(date_text):
            month_match = _MONTH_WORD_RE.search(date_text)
            month = month_match.group(0).lower()
            day_match = re.search(
                r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+" + re.escape(month),
                date_text,
                re.I,
            )
            if day_match and month in months:
                try:
                    parsed = date(proposal_date.year, months[month], int(day_match.group(1)))
                except ValueError:
                    return True
        if parsed is None:
            return True
        candidates.append(parsed)

    # Evaluate every date mentioned: the first may match while a later
    # alternative conflicts with the frozen proposal.
    return len(set(candidates)) > 1 or any(candidate != proposal_date for candidate in candidates)


def _amount_changed(text: str, proposal_paise: int) -> bool:
    """Detect changed or multiple plausible amounts, ignoring date numbers."""
    # Remove explicit dates before asking the shared Hinglish number parser for
    # an amount. This keeps "yes, 15 November" from being treated as ₹15.
    amount_text = _EXPLICIT_DATE_RE.sub(" ", text)
    if not _NUMBER_RE.search(amount_text) and not re.search(
        r"\b(?:ek|do|teen|char|chaar|paanch|pandrah|solah|dhai|hazaar|sau|"
        r"one|two|three|four|five|fifteen|sixteen|hundred|thousand)\b|"
        r"एक|दो|तीन|चार|पांच|पाँच|पंद्रह|सोलह|ढाई|हजार|सौ",
        amount_text,
        re.IGNORECASE,
    ):
        return False
    from normalizer import parse_amount_inr

    # Multiple numeric spans are separate amount candidates once date spans
    # have been removed. This catches lists without an explicit connector too.
    numeric_spans = list(_NUMBER_RE.finditer(amount_text))
    if len(numeric_spans) > 1:
        return True

    # Split alternatives/conjunctions and parse each side independently. A
    # single whole-turn parse would otherwise keep only the first amount in
    # e.g. "haan 300 ya 3000" or "हाँ 300 या 3000".
    parts = _AMOUNT_CONNECTOR_RE.split(amount_text)
    candidates: list[float] = []
    for part in parts:
        parsed, _note = parse_amount_inr(part)
        if parsed is not None:
            candidates.append(parsed)
    if not candidates:
        parsed, _note = parse_amount_inr(amount_text)
        if parsed is not None:
            candidates.append(parsed)
    if not candidates:
        return False
    candidate_paise = {
        int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        for value in candidates
    }
    # More than one amount remains ambiguous even when one or both numbers
    # happen to equal the frozen proposal.
    return len(candidate_paise) > 1 or len(candidates) > 1 or next(iter(candidate_paise)) != proposal_paise


def _canonical_mode(mode: Any) -> str:
    normalized = re.sub(r"[^A-Z]", "", str(mode or "").upper())
    if normalized in {"UPI", "YUPI"}:
        return "UPI"
    if normalized in {"CASH", "NAGAD"}:
        return "CASH"
    if normalized in {"BANK", "BANKTRANSFER", "NEFT", "IMPS", "RTGS", "TRANSFER"}:
        return "BANK"
    return normalized


def _mode_changed(text: str, proposal_mode: Any) -> bool:
    """Return true when a confirmation names another or multiple modes."""
    mentioned: set[str] = set()
    if _UPI_MODE_RE.search(text):
        mentioned.add("UPI")
    if _CASH_MODE_RE.search(text):
        mentioned.add("CASH")
    if _BANK_MODE_RE.search(text):
        mentioned.add("BANK")
    if not mentioned:
        return False
    return len(mentioned) > 1 or _canonical_mode(proposal_mode) not in mentioned


def classify_consent(
    transcript: str,
    proposal: PromiseProposal | Mapping[str, Any] | None = None,
) -> dict[str, str | int | None]:
    """Classify a final turn and retain its affirmative span.

    The return shape is stable for REST, live, and deterministic evaluation:
    ``{status, span_start, span_end}``. A correction/negation never authorizes a
    write, even when the same turn also contains an affirmative token.
    """

    text = str(transcript or "")
    values = _proposal_values(proposal)
    yes = _AFFIRMATIVE_RE.search(text)
    yes_start = yes.start() if yes else None
    yes_end = yes.end() if yes else None

    if _NEGATIVE_RE.search(text):
        status = "negative"
    elif not yes:
        status = "ambiguous"
    elif _CORRECTION_RE.search(text):
        status = "correction"
    else:
        proposal_paise = _canonical_amount_paise(values)
        proposal_date = _canonical_date(values)
        mention_changed_amount = bool(proposal_paise is not None and _amount_changed(text, proposal_paise))
        mention_changed_date = bool(proposal_date is not None and _date_is_mentioned(text) and _date_changed(text, proposal_date))
        mention_changed_mode = _mode_changed(text, values.get("mode"))
        # A question or uncertainty marker is not clear affirmative consent.
        lowered = text.strip().lower()
        uncertain = "?" in text or bool(re.search(r"\b(?:maybe|perhaps|shayad|dekhenge|pata nahi)\b", lowered))
        status = "correction" if mention_changed_amount or mention_changed_date or mention_changed_mode else (
            "ambiguous" if uncertain else "affirmative"
        )

    return {"status": status, "span_start": yes_start, "span_end": yes_end}


# More descriptive alias for callers that prefer the longer name.
classify_confirmation = classify_consent


__all__ = [
    "PromiseProposal",
    "freeze_proposal",
    "classify_consent",
    "classify_confirmation",
]
