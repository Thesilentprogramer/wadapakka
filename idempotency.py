"""Idempotent PTP commits. A retry cannot insert a second row."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any


def commit_key(session_id: str, amount_inr: float, pay_date: str, mode: str) -> str:
    canonical = json.dumps(
        {
            "session_id": session_id,
            "amount_inr": round(float(amount_inr), 2),
            "pay_date": pay_date,
            "mode": mode,
        },
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class Ledger:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.keys: set[str] = set()

    def commit(self, session_id: str, amount_inr: float, pay_date: str, mode: str) -> dict[str, Any]:
        key = commit_key(session_id, amount_inr, pay_date, mode)
        if key in self.keys:
            existing = next(r for r in self.rows if r["commit_key"] == key)
            return {"written": False, "duplicate": True, "row": existing}
        row = {
            "commit_key": key,
            "session_id": session_id,
            "amount_inr": round(float(amount_inr), 2),
            "pay_date": pay_date,
            "mode": mode,
            "written_at": datetime.now(timezone.utc).isoformat(),
        }
        self.keys.add(key)
        self.rows.append(row)
        return {"written": True, "duplicate": False, "row": row}
