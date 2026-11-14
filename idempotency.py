"""SQLite-backed Ledger with one guarded promise-commit entry point.

Rows are written only by :meth:`Ledger.commit_confirmed_promise`, which checks
proposal identity, read-back state, confirmation evidence, and account-level
uniqueness inside a transaction. There is intentionally no public raw insert
or legacy ``commit`` method.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping

from promise_guard import PromiseProposal, classify_consent, freeze_proposal


def commit_key(session_id: str, amount_inr: float, pay_date: str, mode: str) -> str:
    """Compatibility utility for displaying a deterministic proposal hash.

    It is not used as an authorization token and is not a Ledger write API.
    """
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


class LedgerUnavailableError(RuntimeError):
    """Raised by read APIs when the configured SQLite store cannot be read."""


class Ledger:
    """Thread-safe, SQLite-backed storage for confirmed synthetic promises.

    ``db_path`` can point at a caller-owned SQLite file for reuse across Ledger
    instances, or ``":memory:"`` for isolated evaluation. With no path, a
    unique database is created in the system temporary directory and removed
    with its temporary directory when the instance is discarded.

    The public API deliberately exposes reads and one consent-guarded write;
    callers cannot insert a row by passing only session/amount/date/mode.
    """

    def __init__(
        self,
        db_path: str | Path | None = None,
        *,
        path: str | Path | None = None,
        failure_injector: Callable[[], None] | None = None,
        clock: Callable[[], datetime | date] | None = None,
    ) -> None:
        if db_path is not None and path is not None:
            raise ValueError("pass only one of db_path or path")
        selected_path = db_path if db_path is not None else path
        self._lock = threading.RLock()
        self._failure_injector = failure_injector
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._temporary_directory: tempfile.TemporaryDirectory[str] | None = None
        self._memory_connection: sqlite3.Connection | None = None
        self._initialization_error: Exception | None = None

        if selected_path is None:
            self._temporary_directory = tempfile.TemporaryDirectory(prefix="wadapakka-ledger-")
            self.db_path = str(Path(self._temporary_directory.name) / "ledger.sqlite3")
        else:
            self.db_path = str(selected_path)
        self._is_memory = self.db_path == ":memory:"

        try:
            if self._is_memory:
                self._memory_connection = self._connect()
                self._initialize(self._memory_connection)
            else:
                db_parent = Path(self.db_path).expanduser().resolve().parent
                db_parent.mkdir(parents=True, exist_ok=True)
                with self._connection() as conn:
                    self._initialize(conn)
        except Exception as exc:  # Retain failure so routes can report it as a status.
            self._initialization_error = exc

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        if self._is_memory:
            if self._memory_connection is None:
                raise LedgerUnavailableError("in-memory Ledger is closed")
            yield self._memory_connection
            return
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.db_path,
            timeout=10,
            isolation_level=None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @staticmethod
    def _initialize(conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ledger (
                promise_id TEXT PRIMARY KEY,
                proposal_id TEXT NOT NULL UNIQUE,
                proposal_version INTEGER NOT NULL,
                account_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
                pay_date TEXT NOT NULL,
                mode TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('OPEN', 'kept', 'changed', 'broken', 'partial')),
                proposal_hash TEXT NOT NULL,
                confirmation_evidence_id TEXT NOT NULL,
                confirmed_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_one_open_per_account
                ON ledger(account_id) WHERE status = 'OPEN';

            CREATE TABLE IF NOT EXISTS evidence (
                evidence_id TEXT PRIMARY KEY,
                promise_id TEXT NOT NULL UNIQUE,
                proposal_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                turn_id TEXT,
                segment_id TEXT,
                final_transcript TEXT NOT NULL,
                affirmative_start INTEGER NOT NULL,
                affirmative_end INTEGER NOT NULL,
                affirmative_span TEXT NOT NULL,
                readback_turn_id TEXT,
                readback_text TEXT NOT NULL,
                source TEXT NOT NULL CHECK (source IN ('speech', 'ui')),
                observed_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS handoff_cases (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE,
                reason TEXT NOT NULL CHECK (reason IN ('hardship','dispute','wrong_person','other')),
                reason_evidence TEXT NOT NULL, transcript TEXT NOT NULL, created_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('open','taken_over','resolved')),
                taken_over_by TEXT, taken_over_at TEXT, resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS handoff_audit (
                id TEXT PRIMARY KEY, case_id TEXT NOT NULL, action TEXT NOT NULL,
                actor TEXT NOT NULL, occurred_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS payments (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL, amount_paise INTEGER NOT NULL,
                paid_at TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS promise_outcomes (
                id TEXT PRIMARY KEY, promise_id TEXT NOT NULL, outcome TEXT NOT NULL,
                occurred_at TEXT NOT NULL, linked_promise_id TEXT
            );
            """
        )
        # v2 files had a restrictive status CHECK. Rebuild once, preserving rows and evidence.
        schema = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='ledger'").fetchone()[0]
        if "'kept'" not in schema:
            conn.execute("ALTER TABLE ledger RENAME TO ledger_v2")
            conn.execute("DROP INDEX IF EXISTS uq_ledger_one_open_per_account")
            conn.execute("""CREATE TABLE ledger (
                promise_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE,
                proposal_version INTEGER NOT NULL, account_id TEXT NOT NULL,
                session_id TEXT NOT NULL, amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
                pay_date TEXT NOT NULL, mode TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('OPEN','kept','changed','broken','partial')),
                proposal_hash TEXT NOT NULL, confirmation_evidence_id TEXT NOT NULL,
                confirmed_at TEXT NOT NULL, created_at TEXT NOT NULL
            )""")
            conn.execute("INSERT INTO ledger SELECT * FROM ledger_v2")
            conn.execute("DROP TABLE ledger_v2")
            conn.execute("CREATE UNIQUE INDEX uq_ledger_one_open_per_account ON ledger(account_id) WHERE status = 'OPEN'")

    @staticmethod
    def _proposal_hash(proposal: PromiseProposal) -> str:
        canonical = json.dumps(
            {
                "proposal_id": proposal.proposal_id,
                "version": proposal.version,
                "account_id": proposal.account_id,
                "session_id": proposal.session_id,
                "amount_paise": proposal.amount_paise,
                "pay_date": proposal.pay_date,
                "mode": proposal.mode,
                "readback_text": proposal.readback_text,
                "readback_turn_id": proposal.readback_turn_id,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @staticmethod
    def _dict_row(row: sqlite3.Row | Mapping[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        result = dict(row)
        if "amount_paise" in result:
            result["amount_inr"] = round(int(result["amount_paise"]) / 100, 2)
        if "created_at" in result:
            result.setdefault("written_at", result["created_at"])
        return result

    @staticmethod
    def _rejected(error: str, *, decision: Mapping[str, Any] | None = None) -> dict[str, Any]:
        result: dict[str, Any] = {
            "status": "not_committed",
            "written": False,
            "duplicate": False,
            "row": None,
            "evidence": None,
            "evidence_id": None,
            "error": error,
        }
        if decision is not None:
            result["consent"] = dict(decision)
        return result

    @staticmethod
    def _from_open_record(
        row: sqlite3.Row,
        evidence: sqlite3.Row | None,
        status: str,
    ) -> dict[str, Any]:
        row_dict = Ledger._dict_row(row)
        evidence_dict = Ledger._dict_row(evidence)
        is_duplicate = status == "duplicate"
        return {
            "status": status,
            "written": status == "written",
            "duplicate": is_duplicate,
            "row": row_dict,
            "evidence": evidence_dict,
            "evidence_id": row["confirmation_evidence_id"],
        }

    def commit_confirmed_promise(
        self,
        proposal: PromiseProposal | Mapping[str, Any],
        confirmation: Mapping[str, Any],
        *,
        source_turn_id: str | None = None,
        segment_id: str | None = None,
        inject_failure: bool = False,
    ) -> dict[str, Any]:
        """Validate and atomically write a promise with its evidence.

        ``confirmation`` must include the current ``proposal_id``, final
        ``transcript``, and source (``speech`` or explicit ``ui`` acknowledgement).
        Speech is accepted only after ``readback_status='complete'``. The UI
        shortcut is accepted only after ``readback_status='ui_acknowledged'`` and
        an affirmative ``accepted=True`` value.
        """
        if self._initialization_error is not None:
            return self._unavailable(self._initialization_error)

        try:
            frozen = freeze_proposal(proposal)
        except (TypeError, ValueError) as exc:
            return self._rejected(f"invalid_proposal: {exc}")

        if not isinstance(confirmation, Mapping):
            return self._rejected("confirmation_ambiguous")
        supplied_proposal_id = str(confirmation.get("proposal_id") or "")
        if supplied_proposal_id != frozen.proposal_id:
            return self._rejected("stale_proposal")

        source = str(confirmation.get("source") or "speech").strip().lower()
        if source not in {"speech", "ui"}:
            return self._rejected("confirmation_ambiguous")
        if source == "speech" and frozen.readback_status != "complete":
            return self._rejected("readback_incomplete")
        if source == "ui" and frozen.readback_status != "ui_acknowledged":
            return self._rejected("readback_incomplete")
        if not frozen.readback_text:
            return self._rejected("readback_incomplete")

        transcript = str(confirmation.get("transcript") or "")
        if source == "ui" and confirmation.get("accepted") is not True:
            transcript = transcript or "nahi"
        elif source == "ui" and not transcript:
            # Preserve an auditable transcript for the explicit demo button.
            transcript = "haan"
        consent = classify_consent(transcript, frozen)
        if source == "ui" and confirmation.get("accepted") is not True:
            consent = {"status": "negative", "span_start": None, "span_end": None}
        if consent["status"] != "affirmative":
            return self._rejected(
                "confirmation_ambiguous" if consent["status"] == "ambiguous" else "confirmation_not_affirmative",
                decision=consent,
            )

        span_start = int(consent["span_start"])
        span_end = int(consent["span_end"])
        observed_at = datetime.now(timezone.utc).isoformat()
        evidence_id = str(uuid.uuid4())
        promise_id = str(uuid.uuid4())
        turn_id = source_turn_id or confirmation.get("turn_id")
        if turn_id is not None:
            turn_id = str(turn_id)
        if segment_id is None:
            raw_segment_id = confirmation.get("segment_id")
            segment_id = str(raw_segment_id) if raw_segment_id is not None else None
        proposal_hash = self._proposal_hash(frozen)

        active_connection: sqlite3.Connection | None = None
        try:
            with self._lock, self._connection() as conn:
                active_connection = conn
                conn.execute("BEGIN IMMEDIATE")

                owner = conn.execute("SELECT id FROM handoff_cases WHERE session_id = ? AND status IN ('taken_over','resolved')", (frozen.session_id,)).fetchone()
                if owner is not None:
                    conn.rollback()
                    return self._rejected("human_taken_over")

                prior = conn.execute(
                    "SELECT * FROM ledger WHERE proposal_id = ?",
                    (frozen.proposal_id,),
                ).fetchone()
                if prior is not None:
                    if prior["proposal_hash"] != proposal_hash:
                        conn.rollback()
                        return self._rejected("stale_proposal")
                    prior_evidence = conn.execute(
                        "SELECT * FROM evidence WHERE promise_id = ?",
                        (prior["promise_id"],),
                    ).fetchone()
                    conn.commit()
                    return self._from_open_record(prior, prior_evidence, "duplicate")

                open_row = conn.execute(
                    "SELECT * FROM ledger WHERE account_id = ? AND status = 'OPEN'",
                    (frozen.account_id,),
                ).fetchone()
                if open_row is not None:
                    replacing = bool(confirmation.get("replace_promise_id") == open_row["promise_id"])
                    if not replacing:
                        conn.rollback()
                        return {
                        "status": "open_promise_conflict",
                        "written": False,
                        "duplicate": False,
                        "row": self._dict_row(open_row),
                        "evidence": None,
                        "evidence_id": None,
                        "error": "open_promise_conflict",
                        }
                    if open_row["session_id"] == frozen.session_id:
                        conn.rollback()
                        return self._rejected("open_promise_conflict")

                if inject_failure:
                    raise RuntimeError("injected ledger write failure")
                if self._failure_injector is not None:
                    self._failure_injector()

                if open_row is not None:
                    conn.execute("UPDATE ledger SET status = 'changed' WHERE promise_id = ?", (open_row["promise_id"],))
                    conn.execute("INSERT INTO promise_outcomes VALUES (?, ?, 'changed', ?, ?)",
                                 (str(uuid.uuid4()), open_row["promise_id"], observed_at, promise_id))

                conn.execute(
                    """INSERT INTO ledger (
                        promise_id, proposal_id, proposal_version, account_id,
                        session_id, amount_paise, pay_date, mode, status,
                        proposal_hash, confirmation_evidence_id, confirmed_at, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)""",
                    (
                        promise_id,
                        frozen.proposal_id,
                        frozen.version,
                        frozen.account_id,
                        frozen.session_id,
                        frozen.amount_paise,
                        frozen.pay_date,
                        frozen.mode,
                        proposal_hash,
                        evidence_id,
                        observed_at,
                        observed_at,
                    ),
                )
                conn.execute(
                    """INSERT INTO evidence (
                        evidence_id, promise_id, proposal_id, session_id, turn_id,
                        segment_id, final_transcript, affirmative_start,
                        affirmative_end, affirmative_span, readback_turn_id,
                        readback_text, source, observed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        evidence_id,
                        promise_id,
                        frozen.proposal_id,
                        frozen.session_id,
                        turn_id,
                        segment_id,
                        transcript,
                        span_start,
                        span_end,
                        transcript[span_start:span_end],
                        frozen.readback_turn_id,
                        frozen.readback_text,
                        source,
                        observed_at,
                    ),
                )
                conn.commit()
                saved_row = conn.execute(
                    "SELECT * FROM ledger WHERE promise_id = ?", (promise_id,)
                ).fetchone()
                saved_evidence = conn.execute(
                    "SELECT * FROM evidence WHERE evidence_id = ?", (evidence_id,)
                ).fetchone()
                return self._from_open_record(saved_row, saved_evidence, "written")
        except sqlite3.IntegrityError as exc:
            if active_connection is not None:
                active_connection.rollback()
            if "account_id" in str(exc) or "uq_ledger_one_open_per_account" in str(exc):
                return self._conflict_for_account(frozen.account_id)
            if "proposal_id" in str(exc):
                return self._rejected("stale_proposal")
            return self._unavailable(exc)
        except Exception as exc:
            if active_connection is not None:
                try:
                    active_connection.rollback()
                except sqlite3.Error:
                    pass
            return self._unavailable(exc)

    def _conflict_for_account(self, account_id: str) -> dict[str, Any]:
        try:
            with self._lock, self._connection() as conn:
                row = conn.execute(
                    "SELECT * FROM ledger WHERE account_id = ? AND status = 'OPEN'",
                    (account_id,),
                ).fetchone()
                return {
                    "status": "open_promise_conflict",
                    "written": False,
                    "duplicate": False,
                    "row": self._dict_row(row),
                    "evidence": None,
                    "evidence_id": None,
                    "error": "open_promise_conflict",
                }
        except Exception as exc:
            return self._unavailable(exc)

    @staticmethod
    def _unavailable(error: Exception) -> dict[str, Any]:
        return {
            "status": "ledger_unavailable",
            "written": False,
            "duplicate": False,
            "row": None,
            "evidence": None,
            "evidence_id": None,
            "error": "ledger_unavailable",
            "detail": str(error),
        }

    def list_rows(self) -> list[dict[str, Any]]:
        """Return actual guarded Ledger rows ordered by creation time."""
        self._raise_if_unavailable()
        try:
            with self._lock, self._connection() as conn:
                rows = conn.execute("SELECT * FROM ledger ORDER BY created_at, promise_id").fetchall()
                return [self._dict_row(row) for row in rows]  # type: ignore[list-item]
        except Exception as exc:
            raise LedgerUnavailableError("ledger_unavailable") from exc

    @property
    def rows(self) -> list[dict[str, Any]]:
        """Read-only compatibility view; mutating it never changes SQLite."""
        return self.list_rows()

    def get_row(self, promise_id: str) -> dict[str, Any] | None:
        self._raise_if_unavailable()
        try:
            with self._lock, self._connection() as conn:
                row = conn.execute(
                    "SELECT * FROM ledger WHERE promise_id = ?", (str(promise_id),)
                ).fetchone()
                return self._dict_row(row)
        except Exception as exc:
            raise LedgerUnavailableError("ledger_unavailable") from exc

    def get_evidence(self, promise_id: str) -> dict[str, Any] | None:
        """Retrieve saved transcript span and linked complete read-back."""
        self._raise_if_unavailable()
        try:
            with self._lock, self._connection() as conn:
                row = conn.execute(
                    """SELECT e.* FROM evidence e
                       JOIN ledger l ON l.promise_id = e.promise_id
                       WHERE l.promise_id = ?""",
                    (str(promise_id),),
                ).fetchone()
                return self._dict_row(row)
        except Exception as exc:
            raise LedgerUnavailableError("ledger_unavailable") from exc

    def latest_promise(self, account_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT * FROM ledger WHERE account_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", (account_id,)).fetchone()
            return self._dict_row(row)

    def list_promises(self, account_id: str) -> list[dict[str, Any]]:
        self.evaluate_outcomes(account_id)
        with self._lock, self._connection() as conn:
            rows = conn.execute("SELECT * FROM ledger WHERE account_id=? ORDER BY created_at, rowid", (account_id,)).fetchall()
            result = []
            for row in rows:
                item = self._dict_row(row)
                item["outcomes"] = [dict(event) for event in conn.execute(
                    "SELECT * FROM promise_outcomes WHERE promise_id=? ORDER BY occurred_at, rowid", (row["promise_id"],)).fetchall()]
                result.append(item)
            return result

    def record_payment(self, account_id: str, amount_paise: int, paid_at: str) -> dict[str, Any]:
        if amount_paise <= 0:
            raise ValueError("amount must be positive")
        paid = date.fromisoformat(paid_at)
        now = datetime.now(timezone.utc).isoformat()
        payment = {"id": str(uuid.uuid4()), "account_id": account_id,
                   "amount_paise": amount_paise, "amount_inr": amount_paise / 100,
                   "paid_at": paid.isoformat(), "created_at": now}
        with self._lock, self._connection() as conn:
            conn.execute("INSERT INTO payments (id,account_id,amount_paise,paid_at,created_at) VALUES (?,?,?,?,?)",
                         (payment["id"], account_id, amount_paise, paid.isoformat(), now))
        self.evaluate_outcomes(account_id)
        return payment

    def evaluate_outcomes(self, account_id: str) -> None:
        current = self._clock()
        today = current.date() if isinstance(current, datetime) else current
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute("SELECT * FROM ledger WHERE account_id=? AND status='OPEN'", (account_id,)).fetchall()
            for row in rows:
                total = conn.execute("SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE account_id=? AND paid_at<=? AND paid_at>=date(?)",
                                     (account_id, row["pay_date"], row["confirmed_at"])).fetchone()[0]
                outcome = "kept" if total >= row["amount_paise"] else ("partial" if total > 0 and today > date.fromisoformat(row["pay_date"]) else ("broken" if today > date.fromisoformat(row["pay_date"]) else None))
                if outcome:
                    conn.execute("UPDATE ledger SET status=? WHERE promise_id=?", (outcome, row["promise_id"]))
                    conn.execute("INSERT INTO promise_outcomes VALUES (?,?,?,?,NULL)", (str(uuid.uuid4()), row["promise_id"], outcome, now))
            conn.commit()

    def create_handoff(self, account_id: str, session_id: str, reason: str,
                       reason_evidence: str, transcript: list[dict[str, Any]]) -> dict[str, Any]:
        reason = reason if reason in {"hardship", "dispute", "wrong_person"} else "other"
        with self._lock, self._connection() as conn:
            conn.execute("INSERT OR IGNORE INTO handoff_cases VALUES (?,?,?,?,?,? ,?,'open',NULL,NULL,NULL)",
                         (str(uuid.uuid4()), account_id, session_id, reason, reason_evidence,
                          json.dumps(transcript, ensure_ascii=False), datetime.now(timezone.utc).isoformat()))
            return self._handoff_row(conn.execute("SELECT * FROM handoff_cases WHERE session_id=?", (session_id,)).fetchone())

    @staticmethod
    def _handoff_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        item = dict(row)
        item["transcript"] = json.loads(item["transcript"])
        return item

    def list_handoffs(self, status: str | None = None, reason: str | None = None) -> list[dict[str, Any]]:
        with self._lock, self._connection() as conn:
            rows = conn.execute("SELECT * FROM handoff_cases WHERE (? IS NULL OR status=?) AND (? IS NULL OR reason=?) ORDER BY created_at DESC",
                                (status, status, reason, reason)).fetchall()
            return [self._handoff_row(row) for row in rows]

    def get_handoff(self, case_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as conn:
            item = self._handoff_row(conn.execute("SELECT * FROM handoff_cases WHERE id=?", (case_id,)).fetchone())
            if item:
                item["audit_events"] = [dict(row) for row in conn.execute(
                    "SELECT * FROM handoff_audit WHERE case_id=? ORDER BY occurred_at, rowid", (case_id,)).fetchall()]
            return item

    def transition_handoff(self, case_id: str, action: str, actor: str = "demo-agent") -> dict[str, Any] | None:
        with self._lock, self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM handoff_cases WHERE id=?", (case_id,)).fetchone()
            if row is None:
                conn.rollback()
                return None
            if action == "takeover" and row["status"] == "open":
                now = datetime.now(timezone.utc).isoformat()
                conn.execute("UPDATE handoff_cases SET status='taken_over', taken_over_by=?, taken_over_at=? WHERE id=?", (actor, now, case_id))
            elif action == "resolve" and row["status"] == "taken_over":
                now = datetime.now(timezone.utc).isoformat()
                conn.execute("UPDATE handoff_cases SET status='resolved', resolved_at=? WHERE id=?", (now, case_id))
            elif action not in {"takeover", "resolve"} or (action == "resolve" and row["status"] == "open"):
                conn.rollback()
                raise ValueError("invalid handoff transition")
            else:
                now = None
            if now:
                conn.execute("INSERT INTO handoff_audit VALUES (?,?,?,?,?)", (str(uuid.uuid4()), case_id, action, actor, now))
            conn.commit()
            return self.get_handoff(case_id)

    def _raise_if_unavailable(self) -> None:
        if self._initialization_error is not None:
            raise LedgerUnavailableError("ledger_unavailable") from self._initialization_error

    def close(self) -> None:
        """Close an in-memory connection; temporary stores clean up with object."""
        with self._lock:
            if self._memory_connection is not None:
                self._memory_connection.close()
                self._memory_connection = None


__all__ = ["Ledger", "LedgerUnavailableError", "commit_key"]
