"""Deterministic end-to-end replay harness for synthetic reliability scenarios.

The harness deliberately accepts callbacks instead of importing the app. The
caller supplies isolated session and ledger factories, so an Eval run does not
touch the visible demo ledger or process-global session map.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from threading import Barrier
from typing import Any, Callable


ROOT = Path(__file__).resolve().parent
DEFAULT_FIXTURE_PATH = ROOT / "fixtures" / "adversarial_cases.json"
SUCCESS_SPEECH_MARKERS = (
    "promise likh diya",
    "promise noted",
    "promise recorded",
    "promise has been recorded",
    "already recorded",
)


def load_cases(path: str | Path = DEFAULT_FIXTURE_PATH) -> dict[str, Any]:
    """Read the frozen conversation fixture without importing application code."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def run_adversarial_eval(
    handle_turn: Callable[..., dict[str, Any]],
    make_session: Callable[..., dict[str, Any]],
    ledger_factory: Callable[[], Any],
    *,
    fixture_path: str | Path = DEFAULT_FIXTURE_PATH,
) -> dict[str, Any]:
    """Replay the eight personas and their negative variants against callbacks.

    Callback contract::

        make_session(sessions_store=<fresh dict>, today=<frozen date>) -> session
        handle_turn(session_id=..., transcript=..., mode="layer", verbatim=None,
                    stt_meta=..., latency_ms=0, sessions_store=<fresh dict>,
                    ledger_store=<fresh ledger>, record_global=False) -> response

    The harness sets ``stt_meta.source`` to ``text``; optional ``proposal_id``,
    ``segment_id``, and ``inject_failure`` values are carried there for the
    stale-confirmation, duplicate-segment, and injected-write-failure variants.
    """
    fixture = load_cases(fixture_path)
    anchor = date.fromisoformat(fixture["today"])
    persona_results = [
        _run_case(case, handle_turn, make_session, ledger_factory, anchor)
        for case in fixture["cases"]
    ]
    variant_results = [
        _run_variant(case, handle_turn, make_session, ledger_factory, anchor)
        for case in fixture.get("negative_variants", [])
    ]

    metric_population = persona_results + variant_results
    valid_cases = [case for case in persona_results if case["checks"]["valid_promise"]]
    safety_cases = [
        case for case in persona_results
        if case["expected"].get("handoff_reason") in {"hardship", "wrong_person"}
    ]
    metric_results = {
        "exact_promise_fields": _metric(
            sum(bool(case["checks"]["exact_promise_fields"]) for case in valid_cases),
            len(valid_cases),
            "Valid confirmed promises match every expected amount/date/mode field.",
        ),
        "zero_unconfirmed_writes": _metric(
            sum(bool(case["checks"]["zero_unconfirmed_writes"]) for case in metric_population),
            len(metric_population),
            "No row appears before a script step explicitly permits a guarded write.",
        ),
        "hardship_wrong_person_handoff": _metric(
            sum(bool(case["checks"]["correct_safety_handoff"]) for case in safety_cases),
            len(safety_cases),
            "Hardship and wrong-person cases reach the matching handoff with zero rows.",
        ),
        "no_false_refusal_valid_promise": _metric(
            sum(bool(case["checks"]["no_false_refusal"]) for case in valid_cases),
            len(valid_cases),
            "A valid promise conversation is never moved to REFUSED.",
        ),
    }

    passed = all(result["passed"] for result in metric_population)
    return {
        "schema_version": 1,
        "today": fixture["today"],
        "mode": "deterministic_text_replay",
        "synthetic_only": True,
        "case_count": len(persona_results),
        "negative_variant_count": len(variant_results),
        "passed": passed,
        "metrics": metric_results,
        "cases": persona_results,
        "negative_variants": variant_results,
        "limitations": [
            "Text replay does not measure Prisma transcription accuracy or live playback timing.",
            "The date-correction script simulates a transcript arriving during read-back; live audio barge-in needs a separate ReadbackGate test.",
            "Each persona and variant receives a fresh in-memory session map and isolated ledger.",
        ],
    }


def _metric(passed: int, total: int, description: str) -> dict[str, Any]:
    return {
        "passed": passed,
        "total": total,
        "rate": round(passed / total, 4) if total else None,
        "description": description,
    }


def _run_case(
    case: dict[str, Any], handle_turn: Callable[..., dict[str, Any]],
    make_session: Callable[..., dict[str, Any]], ledger_factory: Callable[[], Any],
    today: date,
) -> dict[str, Any]:
    env = _new_environment(make_session, ledger_factory, today)
    proposals: dict[str, str] = {}
    turns = [
        _execute_step(step, env, handle_turn, proposals, case["id"])
        for step in case["turns"]
    ]
    rows = _ledger_rows(env["ledger"])
    gold = case["gold"]
    expected_rows = gold.get("rows", [])
    observed_state = env["session"].get("state")
    observed_handoff = _handoff_reason(turns, env["session"])
    checks = _base_checks(case, turns, rows, expected_rows, observed_state, observed_handoff)
    return {
        "id": case["id"],
        "persona": case["persona"],
        "expected": gold,
        "observed": {
            "state": observed_state,
            "row_count": len(rows),
            "rows": [_public_row(row) for row in rows],
            "handoff_reason": observed_handoff,
        },
        "audit": env["session"].get("audit"),
        "audits": {"primary": env["session"].get("audit")},
        "checks": checks,
        "turns": turns,
        "passed": _case_passed(checks),
        "failed_turn": _first_failed_turn(turns),
    }


def _run_variant(
    case: dict[str, Any], handle_turn: Callable[..., dict[str, Any]],
    make_session: Callable[..., dict[str, Any]], ledger_factory: Callable[[], Any],
    today: date,
) -> dict[str, Any]:
    env = _new_environment(make_session, ledger_factory, today)
    aliases = {"primary": env["session"]}
    for alias in case.get("sessions", []):
        if alias not in aliases:
            aliases[alias] = _make_session(make_session, env["sessions"], today)
    env["aliases"] = aliases
    proposals: dict[str, str] = {}
    turns: list[dict[str, Any]] = []
    for step in case.get("setup", []):
        turns.append(_execute_step(step, env, handle_turn, proposals, case["id"]))

    parallel = case.get("parallel_turns", [])
    if parallel:
        barrier = Barrier(len(parallel))

        def run_parallel(step: dict[str, Any]) -> dict[str, Any]:
            barrier.wait(timeout=10)
            return _execute_step(step, env, handle_turn, proposals, case["id"])

        with ThreadPoolExecutor(max_workers=len(parallel)) as executor:
            futures = [executor.submit(run_parallel, step) for step in parallel]
            turns.extend(future.result() for future in futures)

    for step in case.get("turns", []):
        turns.append(_execute_step(step, env, handle_turn, proposals, case["id"]))

    rows = _ledger_rows(env["ledger"])
    gold = case.get("gold", {})
    expected_rows = gold.get("rows", [])
    if "min_rows" in gold or "max_rows" in gold:
        row_bounds_ok = gold.get("min_rows", 0) <= len(rows) <= gold.get("max_rows", len(rows))
    else:
        row_bounds_ok = len(rows) == len(expected_rows)
    expected_steps_ok = all(turn["expectations_ok"] for turn in turns)
    no_unconfirmed = all(turn.get("row_count_ok", True) for turn in turns)
    statuses_ok = True
    if gold.get("allowed_statuses"):
        actual_statuses = [turn.get("commit_status") for turn in turns if turn.get("commit_status")]
        statuses_ok = bool(actual_statuses) and all(status in gold["allowed_statuses"] for status in actual_statuses)
    exact_fields = True
    if expected_rows:
        exact_fields = _rows_match(rows, expected_rows)
    checks = {
        "valid_promise": bool(expected_rows),
        "exact_promise_fields": exact_fields,
        "zero_unconfirmed_writes": no_unconfirmed and row_bounds_ok,
        "correct_safety_handoff": True,
        "no_false_refusal": not any(turn.get("observed_state") == "REFUSED" for turn in turns),
        "expected_steps": expected_steps_ok,
        "allowed_commit_statuses": statuses_ok,
        "no_false_success_speech": all(turn.get("no_false_success_speech", True) for turn in turns),
    }
    audits = {alias: session.get("audit") for alias, session in aliases.items()}
    return {
        "id": case["id"],
        "description": case["description"],
        "expected": gold,
        "observed": {"row_count": len(rows), "rows": [_public_row(row) for row in rows]},
        # Keep a direct record for the common single-session case. Multi-session
        # variants also expose every isolated audit by alias (for example, both
        # contenders in the same-account concurrency replay).
        "audit": audits.get("primary"),
        "audits": audits,
        "checks": checks,
        "turns": turns,
        "passed": _case_passed(checks),
        "failed_turn": _first_failed_turn(turns),
    }


def _new_environment(make_session: Callable[..., dict[str, Any]], ledger_factory: Callable[[], Any], today: date) -> dict[str, Any]:
    sessions: dict[str, dict[str, Any]] = {}
    ledger = ledger_factory()
    session = _make_session(make_session, sessions, today)
    return {"sessions": sessions, "ledger": ledger, "session": session, "aliases": {"primary": session}}


def _make_session(make_session: Callable[..., dict[str, Any]], sessions: dict[str, dict[str, Any]], today: date) -> dict[str, Any]:
    result = make_session(sessions_store=sessions, today=today)
    if isinstance(result, dict) and isinstance(result.get("session"), dict):
        return result["session"]
    return result


def _execute_step(
    step: dict[str, Any], env: dict[str, Any], handle_turn: Callable[..., dict[str, Any]],
    proposals: dict[str, str], scenario_id: str,
) -> dict[str, Any]:
    alias = step.get("session", "primary")
    session = env.get("aliases", {"primary": env["session"]}).get(alias)
    if session is None:
        return _step_error(step, f"unknown session alias: {alias}")
    stt_meta = {"source": "text", "eval_scenario": scenario_id}
    stt_meta.update(step.get("stt_meta", {}))
    if "segment_id" in step:
        stt_meta["segment_id"] = step["segment_id"]
    if "readback_complete" in step:
        stt_meta["readback_complete"] = step["readback_complete"]
    proposal_from = step.get("proposal_id_from")
    if proposal_from:
        proposal_id = proposals.get(proposal_from)
        if proposal_id:
            stt_meta["proposal_id"] = proposal_id
    try:
        response = handle_turn(
            session_id=session["id"],
            transcript=step["transcript"],
            mode="layer",
            verbatim=None,
            stt_meta=stt_meta,
            latency_ms=0,
            sessions_store=env["sessions"],
            ledger_store=env["ledger"],
            record_global=False,
        )
        response = response if isinstance(response, dict) else {"value": response}
    except Exception as exc:  # Surface API/domain exceptions as case diagnostics, not lost Eval runs.
        response = {"error": _exception_text(exc), "exception_type": type(exc).__name__}

    observed_session = response.get("session") or session
    prompt = str(response.get("prompt", ""))
    commit_status = response.get("commit_status")
    commit = response.get("commit")
    if commit_status is None and isinstance(commit, dict):
        commit_status = commit.get("status")
    if commit_status is None:
        commit_status = observed_session.get("commit_status")
    proposal = response.get("proposal") or observed_session.get("proposal")
    proposal_id = _proposal_id(proposal)
    name = step.get("name")
    if name and proposal_id:
        proposals[name] = proposal_id

    expected_rows = step.get("expect_rows")
    rows = _ledger_rows(env["ledger"])
    row_count_ok = expected_rows is None or len(rows) == expected_rows
    observed_state = observed_session.get("state")
    expectation_failures = []
    if step.get("expect_state") and observed_state != step["expect_state"]:
        expectation_failures.append({"type": "state", "expected": step["expect_state"], "observed": observed_state})
    if expected_rows is not None and len(rows) != expected_rows:
        expectation_failures.append({"type": "row_count", "expected": expected_rows, "observed": len(rows)})
    if step.get("expect_commit_status") and commit_status != step["expect_commit_status"]:
        expectation_failures.append({"type": "commit_status", "expected": step["expect_commit_status"], "observed": commit_status})
    speech = prompt.lower()
    for phrase in step.get("response_contains", []):
        if phrase.lower() not in speech:
            expectation_failures.append({"type": "speech_contains", "expected": phrase})
    for phrase in step.get("forbidden_speech", []):
        if phrase.lower() in speech:
            expectation_failures.append({"type": "forbidden_speech", "found": phrase})
    has_failed_status = commit_status in {
        "write_failed", "ledger_unavailable", "stale_proposal", "readback_incomplete",
        "confirmation_ambiguous", "open_promise_conflict",
    }
    no_false_success_speech = not (has_failed_status and any(marker in speech for marker in SUCCESS_SPEECH_MARKERS))
    if not no_false_success_speech:
        expectation_failures.append({"type": "false_success_speech", "commit_status": commit_status})

    return {
        "name": name,
        "transcript": step["transcript"],
        "expected_state": step.get("expect_state"),
        "observed_state": observed_state,
        "expected_rows": expected_rows,
        "row_count": len(rows),
        "row_count_ok": row_count_ok,
        "commit_status": commit_status,
        "proposal_id": proposal_id,
        "prompt": prompt,
        "error": response.get("error"),
        "expectations_ok": not expectation_failures,
        "expectation_failures": expectation_failures,
        "no_false_success_speech": no_false_success_speech,
    }


def _step_error(step: dict[str, Any], error: str) -> dict[str, Any]:
    return {"name": step.get("name"), "transcript": step.get("transcript"), "error": error,
            "row_count": 0, "row_count_ok": False, "expectations_ok": False,
            "expectation_failures": [{"type": "runner", "error": error}],
            "no_false_success_speech": True}


def _base_checks(case: dict[str, Any], turns: list[dict[str, Any]], rows: list[dict[str, Any]],
                 expected_rows: list[dict[str, Any]], observed_state: str | None,
                 observed_handoff: str | None) -> dict[str, bool]:
    gold = case["gold"]
    handoff_expected = gold.get("handoff_reason")
    unconfirmed_writes = all(turn.get("row_count_ok", True) for turn in turns)
    exact_fields = _rows_match(rows, expected_rows)
    handoff_ok = True
    if handoff_expected in {"hardship", "wrong_person"}:
        handoff_ok = observed_state == "HANDOFF" and observed_handoff == handoff_expected and not rows
    elif handoff_expected:
        handoff_ok = observed_state == "HANDOFF" and observed_handoff == handoff_expected and not rows
    valid = bool(gold.get("valid_promise"))
    return {
        "valid_promise": valid,
        "exact_promise_fields": exact_fields if valid else True,
        "zero_unconfirmed_writes": unconfirmed_writes and len(rows) == len(expected_rows),
        "correct_safety_handoff": handoff_ok,
        "no_false_refusal": (not valid) or not any(turn.get("observed_state") == "REFUSED" for turn in turns),
        "expected_steps": all(turn["expectations_ok"] for turn in turns),
        "no_false_success_speech": all(turn.get("no_false_success_speech", True) for turn in turns),
    }


def _case_passed(checks: dict[str, bool]) -> bool:
    return all(value for key, value in checks.items() if key != "valid_promise")


def _first_failed_turn(turns: list[dict[str, Any]]) -> str | None:
    for turn in turns:
        if not turn.get("expectations_ok", True):
            return turn.get("name") or turn.get("transcript")
    return None


def _rows_match(rows: list[dict[str, Any]], expected: list[dict[str, Any]]) -> bool:
    if len(rows) != len(expected):
        return False
    observed = sorted((_canonical_row(row) for row in rows), key=lambda x: (x["pay_date"] or "", x["amount_inr"] or 0, x["mode"] or ""))
    target = sorted((_canonical_row(row) for row in expected), key=lambda x: (x["pay_date"] or "", x["amount_inr"] or 0, x["mode"] or ""))
    return observed == target


def _canonical_row(row: dict[str, Any]) -> dict[str, Any]:
    amount = row.get("amount_inr")
    if amount is None and row.get("amount_paise") is not None:
        amount = float(row["amount_paise"]) / 100
    return {
        "amount_inr": round(float(amount), 2) if amount is not None else None,
        "pay_date": row.get("pay_date"),
        "mode": row.get("mode"),
    }


def _public_row(row: dict[str, Any]) -> dict[str, Any]:
    public = _canonical_row(row)
    for key in ("promise_id", "session_id", "account_id", "status", "proposal_id", "evidence_id", "confirmation_source"):
        if key in row:
            public[key] = row[key]
    if "evidence_id" not in public and row.get("confirmation_evidence_id"):
        public["evidence_id"] = row["confirmation_evidence_id"]
    return public


def _ledger_rows(ledger: Any) -> list[dict[str, Any]]:
    rows = getattr(ledger, "rows", None)
    if callable(rows):
        rows = rows()
    if rows is None and hasattr(ledger, "list_rows"):
        rows = ledger.list_rows()
    return list(rows or [])


def _proposal_id(proposal: Any) -> str | None:
    if isinstance(proposal, dict):
        value = proposal.get("id") or proposal.get("proposal_id")
        return str(value) if value is not None else None
    return None


def _handoff_reason(turns: list[dict[str, Any]], session: dict[str, Any]) -> str | None:
    if session.get("handoff_reason"):
        return session["handoff_reason"]
    for turn in reversed(turns):
        response_handoff = turn.get("handoff_reason")
        if response_handoff:
            return response_handoff
    # Most handlers retain handoff metadata in the recorded session turn.
    for event in reversed(session.get("turns", [])):
        handoff = event.get("handoff") or {}
        if handoff.get("reason"):
            return handoff["reason"]
    return None


def _exception_text(exc: Exception) -> str:
    detail = getattr(exc, "detail", None)
    if detail is not None:
        return str(detail)
    return str(exc) or type(exc).__name__

