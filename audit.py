"""Rule-based said-versus-saved review for synthetic conversations.

Character spans come from final transcript text; no audio timing or ASR
confidence is inferred here.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from slots import extract_slots


def audit_session(session: dict[str, Any], ledger_rows: list[dict[str, Any]]) -> dict[str, Any]:
    previous = session.get("audit") or {}
    proposal = session.get("proposal") or next(iter(reversed(session.get("proposal_history", []))), None)
    row = next((r for r in ledger_rows if r.get("session_id") == session["id"]), None)
    candidates = []
    snippets = []
    for index, turn in enumerate(session.get("turns", [])):
        if turn.get("mode") == "naive":
            continue
        text = turn.get("transcript", "")
        if not text:
            continue
        parsed = extract_slots(text, today=session.get("today"))
        values = {k: getattr(parsed, k) for k in ("amount_inr", "pay_date", "mode")}
        if values["pay_date"] and values["amount_inr"] and values["amount_inr"] <= 31 and \
                not any(w in text.lower() for w in ("rupay", "rupee", "amount", "₹", "sirf", "only")):
            values["amount_inr"] = None
        turn_id = turn.get("turn_id", str(index + 1))
        if any(v is not None for v in values.values()):
            candidates.append({"turn_id": turn_id, "values": values, "raw": text})
        snippets.append({"turn_id": turn_id, "text": text})
    proposal_fields = None
    if proposal:
        proposal_fields = {"amount_inr": proposal["amount_paise"] / 100,
                           "pay_date": proposal["pay_date"], "mode": proposal["mode"]}
    ledger_fields = None
    if row:
        ledger_fields = {"amount_inr": row.get("amount_paise", 0) / 100,
                         "pay_date": row.get("pay_date"), "mode": row.get("mode")}
    diffs = []
    reasons = []
    for field in ("amount_inr", "pay_date", "mode"):
        values = {str(c["values"][field]) for c in candidates if c["values"][field] is not None}
        if len(values) > 1:
            diffs.append({"field": field, "observed": sorted(values), "reason": "conflicting_turns"})
        if row and proposal_fields and ledger_fields[field] != proposal_fields[field]:
            diffs.append({"field": field, "proposal": proposal_fields[field],
                          "saved": ledger_fields[field], "reason": "said_vs_saved"})
    if diffs:
        reasons.append("conflicting_turns_or_saved_value")
    if session.get("uncertain_reasons"):
        reasons.extend(session["uncertain_reasons"])
    if session.get("state") in {"CLARIFY", "READBACK_PENDING", "AWAITING_CONFIRMATION", "CONFIRMING"}:
        reasons.append("unconfirmed_proposal")
    latest_disagrees = False
    if row:
        for field in ("amount_inr", "pay_date", "mode"):
            latest = next((c["values"][field] for c in reversed(candidates)
                           if c["values"][field] is not None), None)
            if latest is not None and latest != ledger_fields[field]:
                latest_disagrees = True
    if row and (latest_disagrees or any(d["reason"] == "said_vs_saved" for d in diffs)):
        status = "REVIEW_REQUIRED"
    elif row and not session.get("unresolved_fields") and proposal_fields == ledger_fields:
        status = "MATCHED"
        if diffs or session.get("uncertain_reasons"):
            reasons.append("historical_correction_resolved_by_fresh_readback")
    elif diffs or session.get("uncertain_reasons"):
        status = "NEEDS_REVIEW"
    elif proposal and not row:
        status = "UNCONFIRMED"
    elif row:
        status = "MATCHED"
    else:
        status = "NO_PROMISE"
    record = {"audit_id": previous.get("audit_id", str(uuid.uuid4())),
              "session_id": session["id"], "account_id": session["account_id"],
              "run_at": datetime.now(timezone.utc).isoformat(),
              "source_turn_ids": [s["turn_id"] for s in snippets],
              "transcript_snippets": snippets, "parsed_candidates": candidates,
              "proposal_snapshot": dict(proposal) if proposal else None,
              "ledger_snapshot": row, "field_diffs": diffs,
              "reasons": list(dict.fromkeys(reasons)), "status": status}
    session["audit"] = record
    session["audit_status"] = status
    return record
