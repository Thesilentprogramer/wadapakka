"""Public contract checks for proposal identity, evidence, and audit."""
from datetime import date

from fastapi.testclient import TestClient

import app as application
from idempotency import Ledger
from observability import TurnLog


def isolated_client(monkeypatch):
    monkeypatch.setattr(application, "sessions", {})
    monkeypatch.setattr(application, "ledger", Ledger(":memory:"))
    monkeypatch.setattr(application, "turn_log", TurnLog())
    return TestClient(application.app)


def test_stale_button_and_correction_never_commit_old_proposal(monkeypatch):
    client = isolated_client(monkeypatch)
    sid = client.post("/api/session").json()["session"]["id"]
    first = client.post("/api/turn-text", json={"session_id": sid,
        "transcript": "₹2000 on 15 November 2026 by UPI"}).json()
    old = first["proposal"]["id"]
    corrected = client.post("/api/turn-text", json={"session_id": sid,
        "transcript": "16 November 2026"}).json()
    fresh = corrected["proposal"]["id"]
    assert old != fresh
    assert client.post("/api/confirm", json={"session_id": sid,
        "proposal_id": old, "accepted": True}).status_code == 409
    assert client.get("/api/ledger").json()["rows"] == []
    saved = client.post("/api/confirm", json={"session_id": sid,
        "proposal_id": fresh, "accepted": True}).json()
    assert saved["commit_status"] == "written"
    assert saved["commit"]["row"]["pay_date"] == "2026-11-16"
    evidence = client.get("/api/ledger/" + saved["commit"]["row"]["promise_id"] + "/evidence").json()
    assert evidence["source"] == "ui"
    assert evidence["turn_id"] == saved["event"]["turn_id"]
    assert evidence["final_transcript"][evidence["affirmative_start"]:evidence["affirmative_end"]] == "haan"


def test_rest_readback_ack_and_end_audit_are_proposal_bound(monkeypatch):
    client = isolated_client(monkeypatch)
    sid = client.post("/api/session").json()["session"]["id"]
    session = application.sessions[sid]
    session["today"] = date(2026, 11, 13)
    offer = client.post("/api/turn-text", json={"session_id": sid,
        "transcript": "₹300 on 15 November by UPI"}).json()
    pid = offer["proposal"]["id"]
    assert client.post("/api/readback/complete", json={"session_id": sid,
        "proposal_id": "old"}).status_code == 409
    ack = client.post("/api/readback/complete", json={"session_id": sid,
        "proposal_id": pid}).json()
    assert ack["readback_status"] == "complete"
    assert ack["session"]["state"] == "AWAITING_CONFIRMATION"
    end1 = client.post(f"/api/session/{sid}/end").json()["audit"]
    end2 = client.post(f"/api/session/{sid}/end").json()["audit"]
    assert end1["audit_id"] == end2["audit_id"]
    assert end1["status"] == "UNCONFIRMED"
    assert client.get("/api/ledger").json()["rows"] == []
    assert client.get(f"/api/session/{sid}/audit").json()["audit"]["audit_id"] == end1["audit_id"]
    assert any(a["session_id"] == sid for a in client.get("/api/audits?status=UNCONFIRMED").json()["rows"])


def test_ambiguous_values_cannot_be_reconfirmed_by_bare_yes(monkeypatch):
    client = isolated_client(monkeypatch)
    for offer in ("300 or 3000 on 15 November by UPI",
                  "three hundred or three thousand on 15 November by UPI"):
        sid = client.post("/api/session").json()["session"]["id"]
        first = client.post("/api/turn-text", json={"session_id": sid, "transcript": offer}).json()
        assert first["session"]["state"] == "CLARIFY"
        assert "amount_inr" in first["session"]["unresolved_fields"]
        again = client.post("/api/turn-text", json={"session_id": sid, "transcript": "haan"}).json()
        assert again["session"]["state"] == "CLARIFY"
    sid = client.post("/api/session").json()["session"]["id"]
    client.post("/api/turn-text", json={"session_id": sid,
        "transcript": "₹300 on 15 November by UPI"})
    mixed = client.post("/api/turn-text", json={"session_id": sid,
        "transcript": "haan 15 November or 16 November"}).json()
    assert mixed["session"]["state"] == "CLARIFY"
    assert "pay_date" in mixed["session"]["unresolved_fields"]
    client.post("/api/turn-text", json={"session_id": sid, "transcript": "haan"})
    assert client.get("/api/ledger").json()["rows"] == []


def test_decimal_offer_and_post_commit_review(monkeypatch):
    client = isolated_client(monkeypatch)
    sid = client.post("/api/session").json()["session"]["id"]
    first = client.post("/api/turn-text", json={"session_id": sid,
        "transcript": "₹300.50 on 15 November by UPI"}).json()
    assert first["session"]["state"] == "CONFIRMING"
    pid = first["proposal"]["id"]
    saved = client.post("/api/confirm", json={"session_id": sid,
        "proposal_id": pid, "accepted": True}).json()
    assert saved["commit"]["row"]["amount_paise"] == 30050
    review = client.post("/api/turn-text", json={"session_id": sid,
        "transcript": "haan 3000"}).json()
    assert review["audit_status"] == "REVIEW_REQUIRED"
    assert any(row["session_id"] == sid and row["reason"] == "audit_conflict"
               for row in client.get("/api/handoffs").json()["rows"])
    assert client.get("/api/ledger").json()["rows"][0]["review_status"] == "REVIEW_REQUIRED"


def test_isolated_eval_audit_link(monkeypatch):
    client = isolated_client(monkeypatch)
    response = client.get("/api/eval/adversarial/date_correction_invalidates_old_readback/audit")
    assert response.status_code == 200
    assert response.json()["audit"]["audit_id"]
    assert response.json()["mode"] == "deterministic_text_replay"
    assert client.get("/api/eval/adversarial/missing/audit").status_code == 404
    assert application.sessions == {}
    assert application.ledger.rows == []
