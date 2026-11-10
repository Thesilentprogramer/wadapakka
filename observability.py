"""Per-turn observability log: transcript, decisions, latency."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


class TurnLog:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, **event: Any) -> dict[str, Any]:
        row = {"logged_at": datetime.now(timezone.utc).isoformat(), **event}
        self.events.append(row)
        return row
