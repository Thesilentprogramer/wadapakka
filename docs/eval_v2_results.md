# Reliability v2 adversarial Eval — 13 November 2026

Run with:

```bash
python -m pytest tests/test_reliability_v2.py -q
```

The deterministic harness can also be called directly (or from `GET /api/eval/adversarial`):

```python
from adversarial_eval import run_adversarial_eval
from app import _handle_turn, _new_session
from idempotency import Ledger

result = run_adversarial_eval(_handle_turn, _new_session, lambda: Ledger(":memory:"))
```

Verification on 13 November 2026: `python3 -m pytest -q` completed with **29 passed**. Pytest reported one Starlette `BlockingPortal` deprecation warning.

It replays eight synthetic, multi-turn personas and five negative variants. Every replay uses a new session map and in-memory SQLite Ledger; it does not mutate the visible demo sessions or Ledger. The date anchor is fixed at `2026-11-13`.

## Scores

| Check | Result | Scope |
| --- | ---: | --- |
| Exact fields for confirmed promises | **4/4 (100%)** | Amount, ISO payment date, and mode for every valid-promise persona |
| Zero unconfirmed writes | **13/13 (100%)** | Eight personas plus five negative variants |
| Hardship and wrong-person handoff | **2/2 (100%)** | Matching reason and zero Ledger rows |
| No false refusal of a valid promise | **4/4 (100%)** | Angry, partial payer, AI disclosure, and corrected-date conversations |

| Persona | Observed outcome |
| --- | --- |
| Angry | One ₹2,000 / 15 Nov / UPI row after the read-back acknowledgement |
| Partial payer | One ₹300 / 15 Nov / UPI row; the ₹2,500 balance is not saved as the offer |
| Hardship | `hardship` handoff; zero rows |
| Wrong person | `wrong_person` handoff; zero rows |
| Dispute | `dispute` handoff; zero rows |
| Evasive | Remains unconfirmed; zero rows |
| AI disclosure | Truthful AI response, then one ₹300 / 15 Nov / UPI row after acknowledgement |
| Date change and barge-in | Old proposal’s late yes is rejected as `stale_proposal`; fresh proposal saves one ₹2,000 / 16 Nov / UPI row |

| Negative variant | Observed outcome |
| --- | --- |
| Mixed yes plus correction | Does not commit the old proposal |
| Negated yes | No write |
| Repeated segment ID | One saved row; replay adds no row |
| Concurrent confirmations | One open row maximum; the other attempt conflicts |
| Injected Ledger failure | `ledger_unavailable`, neutral retry response, zero rows |

The per-case output, expected/observed states, turn diagnostics, row/evidence references, and final isolated synthetic audit are returned by the harness and the adversarial Eval endpoint. Multi-session variants expose one audit per session alias. Fixture inputs are in [`fixtures/adversarial_cases.json`](../fixtures/adversarial_cases.json).

## Limits

This is deterministic text replay, not an STT accuracy measurement or a production consent claim. The correction case simulates a transcript arriving during read-back; real audio interruption timing is covered separately by `ReadbackGate` tests. The UI acknowledgement is explicitly synthetic and not counted as spoken consent. No live vendor call or borrower data is used.
