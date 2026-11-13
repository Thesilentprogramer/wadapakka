"""Deterministic, isolated adversarial conversation replay checks."""

from __future__ import annotations

from adversarial_eval import load_cases, run_adversarial_eval
from app import app, _handle_turn, _new_session, ledger as visible_ledger, sessions as visible_sessions, turn_log
from idempotency import Ledger
from fastapi.testclient import TestClient


def test_adversarial_fixture_has_eight_personas_and_negative_variants():
    fixture = load_cases()
    assert fixture["today"] == "2026-11-13"
    assert len(fixture["cases"]) == 8
    assert {case["persona"] for case in fixture["cases"]} == {
        "Angry", "Partial payer", "Hardship", "Wrong person", "Dispute",
        "Evasive", "AI disclosure", "Date change and barge-in",
    }
    assert {case["id"] for case in fixture["negative_variants"]} == {
        "mixed_yes_and_correction",
        "negated_yes",
        "repeated_segment_id",
        "concurrent_open_promise_attempts",
        "injected_ledger_failure",
    }


def test_adversarial_replay_scores_all_checks_without_touching_visible_state():
    before_sessions = set(visible_sessions)
    before_rows = list(visible_ledger.rows)
    before_events = len(turn_log.events)

    result = run_adversarial_eval(
        _handle_turn,
        _new_session,
        lambda: Ledger(":memory:"),
    )

    assert result["passed"] is True
    assert result["case_count"] == 8
    assert result["negative_variant_count"] == 5
    assert result["today"] == "2026-11-13"
    assert result["mode"] == "deterministic_text_replay"
    assert result["metrics"]["exact_promise_fields"]["passed"] == 4
    assert result["metrics"]["exact_promise_fields"]["total"] == 4
    assert result["metrics"]["zero_unconfirmed_writes"]["passed"] == 13
    assert result["metrics"]["zero_unconfirmed_writes"]["total"] == 13
    assert result["metrics"]["hardship_wrong_person_handoff"]["passed"] == 2
    assert result["metrics"]["no_false_refusal_valid_promise"]["passed"] == 4

    outcomes = {case["id"]: case for case in result["cases"] + result["negative_variants"]}
    assert all(case["audit"] and case["audit"]["audit_id"] for case in outcomes.values())
    assert all(case["audit"]["session_id"] for case in outcomes.values())
    assert set(outcomes["concurrent_open_promise_attempts"]["audits"]) == {"primary", "secondary"}
    assert all(
        audit and audit["audit_id"]
        for audit in outcomes["concurrent_open_promise_attempts"]["audits"].values()
    )
    correction = outcomes["date_correction_invalidates_old_readback"]
    corrected_row = correction["observed"]["rows"][0]
    assert {key: corrected_row[key] for key in ("amount_inr", "pay_date", "mode")} == {
        "amount_inr": 2000.0, "pay_date": "2026-11-16", "mode": "UPI"
    }
    assert corrected_row["evidence_id"]
    assert next(turn for turn in correction["turns"] if turn["name"] == "late_old_yes")["commit_status"] == "stale_proposal"
    assert outcomes["injected_ledger_failure"]["observed"]["row_count"] == 0
    assert outcomes["concurrent_open_promise_attempts"]["observed"]["row_count"] == 1

    assert set(visible_sessions) == before_sessions
    assert visible_ledger.rows == before_rows
    assert len(turn_log.events) == before_events


def test_adversarial_eval_endpoint_returns_case_level_scores():
    response = TestClient(app).get("/api/eval/adversarial")
    assert response.status_code == 200
    result = response.json()
    assert result["passed"] is True
    assert len(result["cases"]) == 8
    assert len(result["negative_variants"]) == 5
    assert result["metrics"]["zero_unconfirmed_writes"] == {
        "passed": 13,
        "total": 13,
        "rate": 1.0,
        "description": "No row appears before a script step explicitly permits a guarded write.",
    }
