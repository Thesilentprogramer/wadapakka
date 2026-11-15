"""Offline WadaPakka SDK quickstart. Synthetic borrower only; no network, no API key.

    python examples/quickstart.py
"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run from a checkout without installing

from wadapakka import InMemoryStore, Layer, LenderConfig

today = lambda: date(2026, 11, 14)  # injectable clock so the demo is repeatable
events = []
layer = Layer(
    config=LenderConfig(lender_name="Demo Finance", agent_name="Asha", max_amount_inr=50_000),
    store=InMemoryStore(clock=today), clock=today,
    on_event=events.append, borrower_names={"synthetic-ravi-kumar": "Ravi"},
)
acct = "synthetic-ravi-kumar"

print("AGENT :", layer.opening_line(acct, outstanding_inr=2500))
d = layer.on_turn("call-1", acct, "paanch hazaar, 20 November, UPI")
print("1.", d.action, "|", d.say, "|", d.proposal)
d = layer.on_turn("call-1", acct, "haan")
print("2.", d.action, "|", d.say, "| saved:", d.commit["amount_inr"], d.commit["pay_date"], d.commit["mode"])
print("3. retry commit ->", layer.commit("call-1").action, "(idempotent, still 1 row:", len(layer.promises(acct)), ")")

print("\nNext call, memory between calls:")
print("AGENT :", layer.opening_line(acct))
d = layer.on_turn("call-2", acct, "Naukri chali gayi, abhi nahi de sakta")
print("4.", d.action, "| reason:", d.reason, "|", d.say)
case = layer.takeover(d.handoff_case["id"], by="Priya (collections desk)")
print("5. takeover ->", case["status"], "| bot now silent:", layer.on_turn("call-2", acct, "haan").reason)
print("\nevents:", [e["type"] for e in events])
