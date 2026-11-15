"""The ingestible WadaPakka layer.

Sits between any STT (final transcripts) and any TTS (the ``say`` line).
All parsing, read-back, consent and Ledger rules are the SAME code the live
demo runs: this module drives ``app._handle_turn`` with its own session map and
store, so nothing here re-implements the Hinglish rules.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from fastapi import HTTPException

import app as _core  # the same engine the hosted demo uses
from idempotency import Ledger

from .config import LenderConfig
from .events import Emitter
from .stores import InMemoryStore

ACTIONS = ("readback", "wait", "commit", "handoff", "noop")


@dataclass
class Decision:
    action: str                       # readback | wait | commit | handoff | noop
    say: str                          # the Hinglish line to speak via your TTS
    proposal: dict[str, Any] | None = None   # amount_inr / pay_date / mode while one is open
    commit: dict[str, Any] | None = None     # the saved Ledger row on action == "commit"
    handoff_case: dict[str, Any] | None = None
    reason: str | None = None
    audit: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in ("action", "say", "proposal", "commit", "handoff_case", "reason", "audit")}


def _today(clock: Callable[[], date | datetime]) -> date:
    now = clock()
    return now.date() if isinstance(now, datetime) else now


def _slim(proposal: dict[str, Any] | None) -> dict[str, Any] | None:
    if not proposal:
        return None
    return {"proposal_id": proposal["id"], "amount_inr": proposal["amount_paise"] / 100,
            "pay_date": proposal["pay_date"], "mode": proposal["mode"]}


class Layer:
    """Guarded promise-to-pay layer for one lender.

    Commits happen only inside the existing guarded Ledger write, and only
    after a read-back plus an explicit yes; one open promise per account;
    retries are idempotent.
    """

    def __init__(self, config: LenderConfig | None = None, store: Ledger | None = None,
                 clock: Callable[[], date | datetime] | None = None,
                 on_event: Callable[[dict[str, Any]], None] | None = None,
                 borrower_names: dict[str, str] | None = None) -> None:
        self.config = config or LenderConfig()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.store = store if store is not None else InMemoryStore(clock=self.clock)
        self.events = Emitter(on_event, self.config.webhook_url, self.config.webhook_secret)
        self.borrower_names = borrower_names or {}
        self._sessions: dict[str, dict[str, Any]] = {}
        self._ids: dict[str, str] = {}          # caller session id -> engine session id
        self._lock = threading.RLock()

    # ---- memory between calls -------------------------------------------------
    def opening_line(self, account_id: str, outstanding_inr: float | None = None) -> str:
        self.store.evaluate_outcomes(account_id)
        prior = self.store.latest_promise(account_id)
        name = self.borrower_names.get(account_id)
        hello = f"Namaste {name} ji" if name else "Namaste"
        if prior:
            due = date.fromisoformat(prior["pay_date"])
            amount = f"{prior['amount_paise'] / 100:,.2f}".rstrip("0").rstrip(".")
            status = str(prior.get("status") or "OPEN").lower()
            tail = {"kept": " Aapne woh bhar diya, dhanyavaad.",
                    "broken": " Woh payment abhi tak nahi aaya."}.get(status, "")
            return (f"{hello}, pichhli baar aapne {due.day} {due.strftime('%b')} tak ₹{amount} "
                    f"dene ka wada kiya tha.{tail} Aaj aap is baare mein kya kehna chahenge?")
        due = f" Aapka outstanding {outstanding_inr:g} rupaye hai." if outstanding_inr else ""
        return (f"{hello}, main {self.config.agent_name} bol rahi hoon, "
                f"{self.config.lender_name} ki taraf se.{due} Aap kab, kitna, aur kaise bharenge?")

    # ---- sessions -------------------------------------------------------------
    def _session(self, session_id: str, account_id: str) -> dict[str, Any]:
        sid = self._ids.get(session_id)
        if sid:
            return self._sessions[sid]
        session = _core._new_session(self._sessions, today=_today(self.clock), ledger_store=self.store)
        self.store.evaluate_outcomes(account_id)
        session["account_id"] = account_id
        session["remembered_promise"] = self.store.latest_promise(account_id)
        session["opening_prompt"] = self.opening_line(account_id)
        session["dialogue"] = [{"speaker": "agent", "text": session["opening_prompt"]}]
        session["account"] = {"note": "SDK session", "lender": self.config.lender_name}
        session["external_session_id"] = session_id
        self._ids[session_id] = session["id"]
        return session

    def _open_case(self, session: dict[str, Any], reason: str, evidence: str) -> dict[str, Any]:
        session["state"] = "HANDOFF"
        session["handoff_reason"] = reason
        case = self.store.create_handoff(session["account_id"], session["id"], reason, evidence,
                                         session.get("dialogue", []))
        session["handoff_case_id"] = case["id"]
        return case

    def _limit_problem(self, proposal: dict[str, Any]) -> str | None:
        cfg = self.config
        amount = proposal["amount_paise"] / 100
        if amount < cfg.min_amount_inr:
            return "amount_below_min"
        if amount > cfg.max_amount_inr:
            return "amount_above_max"
        if proposal["mode"] not in {m.upper() for m in cfg.allowed_modes}:
            return "mode_not_allowed"
        if date.fromisoformat(proposal["pay_date"]) > _today(self.clock) + timedelta(days=cfg.max_horizon_days):
            return "date_beyond_horizon"
        return None

    # ---- the main entry point -------------------------------------------------
    def on_turn(self, session_id: str, account_id: str, text: str, speaker: str = "borrower") -> Decision:
        """Feed one FINAL STT transcript. Returns what to do and what to say."""
        if speaker != "borrower" or not text.strip():
            return Decision("noop", "", reason="not_a_borrower_turn")
        with self._lock:
            session = self._session(session_id, account_id)
            case_id = session.get("handoff_case_id")
            if case_id:
                case = self.store.get_handoff(case_id)
                if case and case["status"] in {"taken_over", "resolved"}:
                    return Decision("noop", "", reason="human_taken_over", handoff_case=case)
                return Decision("handoff", "", reason=session.get("handoff_reason"), handoff_case=case)
            # Lender-specific handoff keywords, checked before the built-in rules.
            for reason, words in self.config.extra_handoff_keywords.items():
                if any(re.search(re.escape(w), text, re.IGNORECASE) for w in words):
                    session.setdefault("dialogue", []).append({"speaker": "borrower", "text": text})
                    case = self._open_case(session, reason, text)
                    self.events.emit("handoff.opened", case)
                    return Decision("handoff", "Theek hai, main aapko abhi ek saathi se jod rahi hoon.",
                                    reason=case["reason"], handoff_case=case, audit={"rule": "lender_keyword"})
            meta: dict[str, Any] = {"source": "text"}
            if session.get("state") in {"CONFIRMING", "AWAITING_CONFIRMATION", "COMMIT_FAILED"} and session.get("active_proposal_id"):
                # the integrator spoke our read-back; bind this answer to that exact proposal
                meta["proposal_id"] = session["active_proposal_id"]
            try:
                result = _core._handle_turn(session["id"], text, "layer", None, meta, 0,
                                            sessions_store=self._sessions, ledger_store=self.store,
                                            record_global=False)
            except HTTPException as exc:
                return Decision("noop", "", reason=str(exc.detail))
            return self._decide(session, result)

    def _decide(self, session: dict[str, Any], result: dict[str, Any]) -> Decision:
        state = session["state"]
        say = result.get("prompt") or ""
        audit = {"state": state, "audit_status": session.get("audit_status"),
                 "commit_status": result.get("commit_status"), "event": result.get("event", {}).get("decision")}
        proposal = session.get("proposal")
        commit = result.get("commit") or {}
        if result.get("commit_status") in {"written", "duplicate"} and commit.get("row"):
            row = commit["row"]
            if result["commit_status"] == "written":
                prior = session.get("remembered_promise")
                self.events.emit("promise.committed", row)
                if prior and prior.get("promise_id") != row["promise_id"]:
                    previous = self.store.get_row(prior["promise_id"]) or prior
                    if str(previous.get("status")).lower() == "changed":
                        self.events.emit("promise.changed", {"previous": previous, "current": row})
            return Decision("commit", say, _slim(proposal), commit=row, audit=audit)
        if state == "HANDOFF":
            case = result.get("handoff_case")
            if case is None and session.get("handoff_case_id") is None:
                case = self._open_case(session, session.get("handoff_reason") or "other", result.get("transcript", ""))
            if case is not None:
                self.events.emit("handoff.opened", case)
            return Decision("handoff", say, _slim(proposal), handoff_case=case,
                            reason=session.get("handoff_reason") or (case or {}).get("reason"), audit=audit)
        if state == "CONFIRMING" and proposal and result.get("proposal"):
            problem = self._limit_problem(proposal)
            if problem:
                audit["limit"] = problem
                if self.config.on_limit_violation == "handoff":
                    case = self._open_case(session, "other", f"{problem}: {result.get('transcript', '')}")
                    self.events.emit("handoff.opened", case)
                    return Decision("handoff", "Yeh main akeli tay nahi kar sakti. Main aapko ek saathi se jod rahi hoon.",
                                    _slim(proposal), handoff_case=case, reason=problem, audit=audit)
                session["state"] = "COLLECTING"
                session["proposal"] = None
                session["active_proposal_id"] = None
                return Decision("wait", "Yeh option hamare paas nahi hai. Kripya doosri raashi, tareekh ya mode batayiye.",
                                reason=problem, audit=audit)
            return Decision("readback", say, _slim(proposal), audit=audit)
        return Decision("wait", say, _slim(proposal), audit=audit)

    # ---- explicit controls ----------------------------------------------------
    def confirm(self, session_id: str, yes: bool, account_id: str | None = None) -> Decision:
        """Button/DTMF style confirmation of the open read-back."""
        sid = self._ids.get(session_id)
        if not sid:
            return Decision("noop", "", reason="unknown_session")
        return self.on_turn(session_id, account_id or self._sessions[sid]["account_id"],
                            "haan" if yes else "nahi, galat hai")

    def commit(self, session_id: str) -> Decision:
        """Idempotent: returns the saved row if the guard already let it through.

        There is deliberately no way to force a write: without a read-back and an
        explicit yes this returns action="wait" with reason="no_confirmation".
        """
        sid = self._ids.get(session_id)
        session = self._sessions.get(sid) if sid else None
        if not session:
            return Decision("noop", "", reason="unknown_session")
        row = next((r for r in self.store.rows if r["session_id"] == sid), None)
        if row:
            return Decision("commit", "Promise pehle hi likh diya gaya hai.", _slim(session.get("proposal")),
                            commit=row, audit={"commit_status": "duplicate"})
        return Decision("wait", "Confirm karne ke liye boliye haan.", _slim(session.get("proposal")),
                        reason="no_confirmation", audit={"state": session["state"]})

    def record_payment(self, account_id: str, amount_inr: float, paid_at: str | date) -> dict[str, Any]:
        paid = paid_at.isoformat() if isinstance(paid_at, date) else paid_at
        return self.store.record_payment(account_id, round(amount_inr * 100), paid)

    def promises(self, account_id: str) -> list[dict[str, Any]]:
        return self.store.list_promises(account_id)

    def handoffs(self, status: str | None = None, reason: str | None = None) -> list[dict[str, Any]]:
        return self.store.list_handoffs(status, reason)

    def takeover(self, case_id: str, by: str = "human agent") -> dict[str, Any] | None:
        with self._lock:
            case = self.store.transition_handoff(case_id, "takeover", by)
            if case:
                session = self._sessions.get(case["session_id"])
                if session:
                    session["human_owned"] = True
                self.events.emit("handoff.taken_over", case)
            return case

    def resolve(self, case_id: str) -> dict[str, Any] | None:
        return self.store.transition_handoff(case_id, "resolve")
