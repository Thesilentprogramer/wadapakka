from datetime import date

from fastapi.testclient import TestClient

import app as application
from idempotency import Ledger
from observability import TurnLog


ACCOUNT = "synthetic-ravi-kumar"


def setup(monkeypatch, clock=lambda: date(2026, 11, 14)):
    monkeypatch.setattr(application, "sessions", {})
    monkeypatch.setattr(application, "ledger", Ledger(":memory:", clock=clock))
    monkeypatch.setattr(application, "turn_log", TurnLog())
    return TestClient(application.app)


def promise(http, amount=3000, due="15 November 2026"):
    sid = http.post("/api/session").json()["session"]["id"]
    offer = http.post("/api/turn-text", json={"session_id": sid,
        "transcript": f"₹{amount} on {due} by UPI"}).json()
    assert offer["session"]["state"] == "CONFIRMING"
    saved = http.post("/api/confirm", json={"session_id": sid,
        "proposal_id": offer["proposal"]["id"], "accepted": True}).json()
    assert saved["commit_status"] == "written"
    return saved["commit"]["row"]


def test_memory_and_kept_payment(monkeypatch):
    http = setup(monkeypatch)
    first = promise(http)
    followup = http.post("/api/session").json()
    assert "15 Nov" in followup["prompt"] and "₹3,000" in followup["prompt"]
    assert followup["session"]["remembered_promise"]["promise_id"] == first["promise_id"]
    paid = http.post("/api/payments", json={"account_id": ACCOUNT, "amount_inr": 3000,
        "paid_at": "2026-11-15", "synthetic": True}).json()
    assert paid["amount_paise"] == 300000
    history = http.get(f"/api/accounts/{ACCOUNT}/promises").json()["rows"]
    assert history[0]["status"] == "kept"
    assert history[0]["outcomes"][0]["outcome"] == "kept"


def test_changed_requires_fresh_readback_and_yes(monkeypatch):
    http = setup(monkeypatch)
    first = promise(http)
    sid = http.post("/api/session").json()["session"]["id"]
    offer = http.post("/api/turn-text", json={"session_id": sid,
        "transcript": "₹2000 on 16 November 2026 by UPI"}).json()
    assert len(application.ledger.rows) == 1
    sneaky = http.post("/api/turn-text", json={"session_id": sid,
        "transcript": "haan, lekin 500"}).json()
    assert sneaky.get("commit_status") != "written"
    assert len(application.ledger.rows) == 1
    fresh = http.post("/api/turn-text", json={"session_id": sid,
        "transcript": "₹2000 on 16 November 2026 by UPI"}).json()
    saved = http.post("/api/confirm", json={"session_id": sid,
        "proposal_id": fresh["proposal"]["id"], "accepted": True}).json()
    assert saved["commit_status"] == "written"
    history = http.get(f"/api/accounts/{ACCOUNT}/promises").json()["rows"]
    assert [r["status"] for r in history] == ["changed", "OPEN"]
    assert history[0]["outcomes"][0]["linked_promise_id"] == history[1]["promise_id"]
    assert len([r for r in history if r["status"] == "OPEN"]) == 1
    assert first["promise_id"] != history[1]["promise_id"]


def test_broken_with_injectable_clock(monkeypatch):
    today = [date(2026, 11, 14)]
    http = setup(monkeypatch, clock=lambda: today[0])
    promise(http)
    today[0] = date(2026, 11, 16)
    history = http.get(f"/api/accounts/{ACCOUNT}/promises").json()["rows"]
    assert history[0]["status"] == "broken"
    assert history[0]["outcomes"][0]["outcome"] == "broken"


def test_disputed_memory_routes_to_case_with_saved_evidence(monkeypatch):
    http = setup(monkeypatch)
    promise(http)
    sid = http.post("/api/session").json()["session"]["id"]
    result = http.post("/api/turn-text", json={"session_id": sid,
        "transcript": "maine aisa nahi bola"}).json()
    case = result["handoff_case"]
    assert case["reason"] == "dispute"
    assert "saved promise" in case["reason_evidence"]
    assert "300000" in case["reason_evidence"]
    assert len(application.ledger.rows) == 1
