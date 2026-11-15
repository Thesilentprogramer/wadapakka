"""SDK tests: the ingestible Layer drives the same engine as the hosted demo."""
import hashlib
import hmac
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

from wadapakka import InMemoryStore, Layer, LenderConfig, SQLiteStore, sign
from wadapakka.adapters import guard_transcript

ACCT = "synthetic-ravi-kumar"
TODAY = lambda: date(2026, 11, 14)


def make(**cfg):
    events = []
    layer = Layer(config=LenderConfig(**cfg), store=InMemoryStore(clock=TODAY), clock=TODAY,
                  on_event=events.append, borrower_names={ACCT: "Ravi"})
    return layer, events


def test_quickstart_flow_readback_yes_commit_memory_handoff():
    layer, events = make()
    d = layer.on_turn("c1", ACCT, "paanch hazaar, 20 November, UPI")
    assert d.action == "readback" and "5000" in d.say
    assert d.proposal["amount_inr"] == 5000 and d.proposal["pay_date"] == "2026-11-20" and d.proposal["mode"] == "UPI"
    d = layer.on_turn("c1", ACCT, "haan")
    assert d.action == "commit" and d.commit["amount_paise"] == 500000
    opener = layer.opening_line(ACCT)
    assert "20 Nov" in opener and "₹5,000" in opener and "Ravi" in opener
    d = layer.on_turn("c2", ACCT, "Naukri chali gayi")
    assert d.action == "handoff" and d.reason == "hardship" and d.handoff_case["transcript"]
    assert [e["type"] for e in events] == ["promise.committed", "handoff.opened"]


def test_no_commit_without_yes():
    layer, _ = make()
    layer.on_turn("c1", ACCT, "teen hazaar 18 November UPI")
    assert layer.commit("c1").action == "wait"
    d = layer.on_turn("c1", ACCT, "nahi, galat hai")
    assert d.action != "commit"
    assert layer.commit("c1").reason == "no_confirmation"
    assert layer.promises(ACCT) == []


def test_commit_is_idempotent():
    layer, events = make()
    layer.on_turn("c1", ACCT, "teen hazaar 18 November UPI")
    first = layer.confirm("c1", True)
    again = layer.confirm("c1", True)
    assert first.action == again.action == "commit"
    assert first.commit["promise_id"] == again.commit["promise_id"] == layer.commit("c1").commit["promise_id"]
    assert len(layer.promises(ACCT)) == 1
    assert sum(e["type"] == "promise.committed" for e in events) == 1


def test_one_open_promise_per_account():
    layer, _ = make()
    # two concurrent calls for the same account both reach a read-back
    assert layer.on_turn("c1", ACCT, "teen hazaar 18 November UPI").action == "readback"
    assert layer.on_turn("c2", ACCT, "do hazaar 19 November cash").action == "readback"
    assert layer.on_turn("c1", ACCT, "haan").action == "commit"
    d = layer.on_turn("c2", ACCT, "haan")
    assert d.action == "handoff" and d.reason == "open_promise_conflict"
    assert len(layer.promises(ACCT)) == 1


def test_followup_change_needs_fresh_yes_and_marks_changed():
    layer, events = make()
    layer.on_turn("c1", ACCT, "teen hazaar 18 November UPI")
    layer.on_turn("c1", ACCT, "haan")
    assert layer.on_turn("c2", ACCT, "do hazaar 19 November cash").action == "readback"
    assert layer.on_turn("c2", ACCT, "haan").action == "commit"
    statuses = sorted(r["status"] for r in layer.promises(ACCT))
    assert statuses == ["OPEN", "changed"]
    assert [e["type"] for e in events] == ["promise.committed", "promise.committed", "promise.changed"]


def test_amount_over_max_hands_off():
    layer, events = make(max_amount_inr=4000)
    d = layer.on_turn("c1", ACCT, "paanch hazaar, 20 November, UPI")
    assert d.action == "handoff" and d.reason == "amount_above_max"
    assert layer.on_turn("c1", ACCT, "haan").action != "commit"
    assert layer.promises(ACCT) == [] and events[-1]["type"] == "handoff.opened"


def test_reject_mode_and_horizon_ask_again():
    layer, _ = make(allowed_modes=("UPI",), on_limit_violation="reject", max_horizon_days=3)
    d = layer.on_turn("c1", ACCT, "teen hazaar 15 November cash")
    assert d.action == "wait" and d.reason == "mode_not_allowed"
    d = layer.on_turn("c1", ACCT, "teen hazaar 30 November UPI")
    assert d.action == "wait" and d.reason == "date_beyond_horizon"
    d = layer.on_turn("c1", ACCT, "teen hazaar 16 November UPI")
    assert d.action == "readback"
    assert layer.on_turn("c1", ACCT, "haan").action == "commit"


def test_memory_opener_and_kept_outcome(tmp_path):
    store = SQLiteStore(tmp_path / "ledger.db", clock=TODAY)
    layer = Layer(store=store, clock=TODAY, borrower_names={ACCT: "Ravi"})
    assert "pichhli baar" not in layer.opening_line(ACCT)
    layer.on_turn("c1", ACCT, "₹3000 on 15 November 2026 by UPI")
    layer.on_turn("c1", ACCT, "haan")
    # a new process / new Layer on the same file still remembers
    later = Layer(store=SQLiteStore(tmp_path / "ledger.db", clock=TODAY), clock=TODAY)
    assert "15 Nov" in later.opening_line(ACCT) and "₹3,000" in later.opening_line(ACCT)
    later.record_payment(ACCT, 3000, "2026-11-15")
    assert later.promises(ACCT)[0]["status"] == "kept"
    assert "dhanyavaad" in later.opening_line(ACCT)


def test_handoff_takeover_blocks_bot_writes():
    layer, events = make()
    d = layer.on_turn("c1", ACCT, "wrong number hai, main Ravi nahi hoon")
    assert d.action == "handoff" and d.reason == "wrong_person"
    case = layer.takeover(d.handoff_case["id"], by="desk")
    assert case["status"] == "taken_over"
    assert layer.takeover(case["id"])["status"] == "taken_over"  # idempotent
    after = layer.on_turn("c1", ACCT, "teen hazaar 18 November UPI")
    assert after.action == "noop" and after.reason == "human_taken_over"
    assert layer.on_turn("c1", ACCT, "haan").action == "noop"
    assert layer.promises(ACCT) == []
    assert layer.handoffs(status="taken_over")[0]["id"] == case["id"]


def test_lender_keywords_extend_handoff():
    layer, events = make(extra_handoff_keywords={"hardship": ["bimaar hoon"], "legal": ["vakeel"]})
    assert layer.on_turn("c1", ACCT, "Main bimaar hoon").reason == "hardship"
    d = layer.on_turn("c2", ACCT, "mere vakeel se baat karo")
    assert d.action == "handoff" and d.handoff_case["reason"] == "other"


def test_new_promise_after_kept_is_not_a_change():
    layer, events = make()
    layer.on_turn("c1", ACCT, "₹3000 on 15 November 2026 by UPI")
    layer.on_turn("c1", ACCT, "haan")
    layer.record_payment(ACCT, 3000, "2026-11-15")  # closes the first promise as kept
    layer.on_turn("c2", ACCT, "₹2000 on 25 November 2026 by UPI")
    assert layer.on_turn("c2", ACCT, "haan").action == "commit"
    assert [e["type"] for e in events] == ["promise.committed", "promise.committed"]


def test_guard_transcript_adapter_ignores_partials():
    layer, _ = make()
    spoken, handed = [], []
    assert guard_transcript(layer, "c1", ACCT, "paanch haz", is_final=False, speak=spoken.append) is None
    d = guard_transcript(layer, "c1", ACCT, "paanch hazaar, 20 November, UPI", speak=spoken.append)
    assert d.action == "readback" and spoken == [d.say]
    guard_transcript(layer, "c2", ACCT, "dispute hai, statement bhejo", on_handoff=handed.append)
    assert handed and handed[0].reason == "dispute"


def test_webhook_signature_helper():
    body = json.dumps({"type": "promise.committed"}).encode()
    assert sign(body, "s3cret") == "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()


def test_quickstart_script_runs():
    root = Path(__file__).resolve().parents[1]
    out = subprocess.run([sys.executable, str(root / "examples" / "quickstart.py")],
                         capture_output=True, text=True, check=True).stdout
    assert "commit" in out and "hardship" in out and "taken_over" in out
