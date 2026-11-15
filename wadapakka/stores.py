"""Storage back-ends. Both wrap the existing guarded SQLite Ledger (idempotency.py)."""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from typing import Callable

from idempotency import Ledger


def SQLiteStore(path: str | Path, clock: Callable[[], date | datetime] | None = None) -> Ledger:
    """Persistent store: promises, outcomes, payments and handoff cases in one SQLite file."""
    return Ledger(str(path), clock=clock)


def InMemoryStore(clock: Callable[[], date | datetime] | None = None) -> Ledger:
    """Throwaway store for tests, evals and offline demos."""
    return Ledger(":memory:", clock=clock)
