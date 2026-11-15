"""Regression tests for Hinglish amount corrections and date/amount separation."""
from fastapi.testclient import TestClient
import pytest

import app as application
from idempotency import Ledger
from normalizer import parse_amount_inr, parse_relative_date
from observability import TurnLog


@pytest.mark.parametrize("text, expected", [
    ("Teen hazaar nahi ho payega, paanch hazaar 20 November UPI se", 5000),
    ("Paanch hazaar, 20 November, UPI", 5000),
    ("Correct: nahi, paanch hazaar 20 November UPI", 5000),
    ("3000 nahi, 5000 20 Nov UPI", 5000),
    ("do hazaar nahi, teen hazaar parso", 3000),
    ("sawa teen sau", 325),
    ("teen hazaar parso UPI", 3000),
    ("₹2000 on 15 November 2026 by UPI", 2000),
    ("November 20 ko paanch hazaar", 5000),
])
def test_amount_parser_regressions(text, expected):
    assert parse_amount_inr(text)[0] == expected


def test_date_only_turn_has_no_amount():
    assert parse_amount_inr("haan 20 November")[0] is None


def test_date_still_parsed_alongside_amount():
    from datetime import date
    assert parse_relative_date("Paanch hazaar, 20 November, UPI", today=date(2026, 11, 15))[0] == date(2026, 11, 20)


def _client(monkeypatch):
    monkeypatch.setattr(application, "sessions", {})
    monkeypatch.setattr(application, "ledger", Ledger(":memory:"))
    monkeypatch.setattr(application, "turn_log", TurnLog())
    return TestClient(application.app)


def _turn(client, sid, text):
    return client.post("/api/turn-text", json={"session_id": sid, "transcript": text}).json()


def test_layer_reads_back_corrected_amount_after_negation(monkeypatch):
    client = _client(monkeypatch)
    sid = client.post("/api/session").json()["session"]["id"]
    out = _turn(client, sid, "Teen hazaar nahi ho payega, paanch hazaar 20 November UPI se")
    assert out["proposal"]["amount_paise"] == 500000
    assert out["proposal"]["pay_date"].endswith("-11-20")


def test_layer_takes_new_amount_after_earlier_turn(monkeypatch):
    client = _client(monkeypatch)
    sid = client.post("/api/session").json()["session"]["id"]
    _turn(client, sid, "teen hazaar parso UPI")
    out = _turn(client, sid, "Paanch hazaar, 20 November, UPI")
    assert out["proposal"]["amount_paise"] == 500000
    assert out["proposal"]["pay_date"].endswith("-11-20")


def test_correction_on_readback_parses_new_amount(monkeypatch):
    client = _client(monkeypatch)
    sid = client.post("/api/session").json()["session"]["id"]
    first = _turn(client, sid, "teen hazaar 20 November UPI")
    assert first["proposal"]["amount_paise"] == 300000
    out = _turn(client, sid, "Correct: nahi, paanch hazaar 20 November UPI")
    assert out["proposal"]["amount_paise"] == 500000
    assert out["proposal"]["id"] != first["proposal"]["id"]
    assert client.get("/api/ledger").json()["rows"] == []
