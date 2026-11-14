from datetime import date

from fastapi.testclient import TestClient

import app as application
from handoff import detect_handoff
from idempotency import Ledger
from observability import TurnLog


def client(monkeypatch):
    monkeypatch.setattr(application, "sessions", {})
    monkeypatch.setattr(application, "ledger", Ledger(":memory:"))
    monkeypatch.setattr(application, "turn_log", TurnLog())
    return TestClient(application.app)


def test_reason_rules_and_case_lifecycle(monkeypatch):
    http = client(monkeypatch)
    for utterance, reason in [("naukri chali gayi", "hardship"), ("hospital mein hoon", "hardship"),
                              ("maine already pay kiya", "dispute"), ("galat number", "wrong_person"),
                              ("main Ravi nahi hoon", "wrong_person"), ("agent se baat", "other")]:
        sid = http.post("/api/session").json()["session"]["id"]
        result = http.post("/api/turn-text", json={"session_id": sid, "transcript": utterance}).json()
        case = result["handoff_case"]
        assert case["reason"] == reason
        assert utterance in case["reason_evidence"]
        assert case["transcript"][-2]["speaker"] == "borrower"
        assert all(t["timestamp"] for t in case["transcript"])
        assert http.get(f"/api/handoffs/{case['id']}").json()["id"] == case["id"]
        assert any(r["id"] == case["id"] for r in http.get(f"/api/handoffs?reason={reason}&status=open").json()["rows"])
        taken = http.post(f"/api/handoffs/{case['id']}/takeover", json={"taken_over_by": "Demo reviewer"}).json()
        assert taken["status"] == "taken_over" and taken["taken_over_by"] == "Demo reviewer"
        assert http.post(f"/api/handoffs/{case['id']}/takeover").json()["taken_over_at"] == taken["taken_over_at"]
        assert [event["action"] for event in http.get(f"/api/handoffs/{case['id']}").json()["audit_events"]] == ["takeover"]
        assert http.post("/api/turn-text", json={"session_id": sid, "transcript": "haan"}).status_code == 409
        assert http.post(f"/api/handoffs/{case['id']}/resolve").json()["status"] == "resolved"
        assert [event["action"] for event in http.get(f"/api/handoffs/{case['id']}").json()["audit_events"]] == ["takeover", "resolve"]
        assert http.post(f"/api/handoffs/{case['id']}/resolve").json()["status"] == "resolved"


def test_ledger_guard_blocks_taken_over_session(monkeypatch):
    http = client(monkeypatch)
    sid = http.post("/api/session").json()["session"]["id"]
    proposal = http.post("/api/turn-text", json={"session_id": sid, "transcript": "₹3000 on 15 November 2026 by UPI"}).json()["proposal"]
    case = application.ledger.create_handoff(application.SYNTHETIC_ACCOUNT_ID, sid, "other", "human review", [])
    http.post(f"/api/handoffs/{case['id']}/takeover")
    proposal["readback_status"] = "ui_acknowledged"
    result = application.ledger.commit_confirmed_promise(proposal, {"proposal_id": proposal["id"], "source": "ui", "accepted": True, "transcript": "haan"})
    assert result["error"] == "human_taken_over"
    assert application.ledger.rows == []
