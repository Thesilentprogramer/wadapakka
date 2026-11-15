# WadaPakka SDK: an ingestible promise-to-pay layer

WadaPakka drops in between **any STT** (final transcripts) and **any TTS** (the line to speak) on a collections call. Any lender or voice-agent stack (Pipecat, LiveKit, an Exotel/Twilio/Plivo dialer, an in-house IVR) gets the same guarantees the live demo has:

- Hinglish amounts, dates and payment modes are parsed into exact values ("paanch hazaar, 20 November, UPI" → ₹5,000 · 2026-11-20 · UPI).
- Nothing is saved until the borrower has **heard a read-back and said a clear yes**.
- **One open promise per account**, and commits are **idempotent** (retries never double-write).
- **Handoffs** with reasons (hardship, dispute, wrong person) and the transcript attached; a human **takeover** silences the bot.
- **Memory between calls**: "pichhli baar aapne 20 Nov tak ₹5,000 dene ka wada kiya tha", with kept / changed / broken outcomes.

The SDK runs the **same engine** as the hosted demo (`app._handle_turn`, `promise_guard`, the guarded `idempotency.Ledger`, `handoff`). No rules are forked, so the adversarial eval covers both.

## Install

```bash
pip install git+https://github.com/Thesilentprogramer/wadapakka
```

Python 3.10+. Offline use needs no API key. Gnani Prisma/Timbre keys are only needed if you call the bundled STT/TTS clients.

## Quickstart (offline, synthetic borrower)

```python
from wadapakka import Layer, LenderConfig, SQLiteStore

layer = Layer(config=LenderConfig(lender_name="Demo Finance", agent_name="Asha"),
              store=SQLiteStore("wadapakka.db"))
acct = "synthetic-ravi-kumar"

print(layer.opening_line(acct))                          # memory-aware greeting -> TTS
d = layer.on_turn("call-1", acct, "paanch hazaar, 20 November, UPI")
print(d.action, d.say)                                   # readback  "Confirm karne ke liye boliye haan..."
d = layer.on_turn("call-1", acct, "haan")
print(d.action, d.commit["amount_inr"])                  # commit 5000.0
print(layer.on_turn("call-2", acct, "Naukri chali gayi").action)   # handoff (hardship)
```

The full runnable version is in `examples/quickstart.py` (`python examples/quickstart.py`).

## API

| Call | Returns | Notes |
|---|---|---|
| `Layer(config=LenderConfig(), store=InMemoryStore() \| SQLiteStore(path), clock=None, on_event=None, borrower_names=None)` | layer | `clock` is injectable (date or datetime) for tests and replays |
| `layer.on_turn(session_id, account_id, text, speaker="borrower")` | `Decision` | Feed **final** transcripts only |
| `layer.confirm(session_id, yes)` | `Decision` | Button/DTMF confirmation of the open read-back |
| `layer.commit(session_id)` | `Decision` | Idempotent read of the guarded write. It cannot force a write: without read-back + yes it returns `wait` / `no_confirmation` |
| `layer.opening_line(account_id, outstanding_inr=None)` | `str` | Memory between calls, including the kept/broken outcome |
| `layer.record_payment(account_id, amount_inr, paid_at)` | payment | Drives kept / partial / broken outcomes |
| `layer.promises(account_id)` | rows | Promise history with outcomes |
| `layer.handoffs(status=None, reason=None)` | cases | Handoff desk |
| `layer.takeover(case_id, by=...)` / `layer.resolve(case_id)` | case | Takeover is idempotent and blocks further bot turns |

`Decision` fields:

- `action`: `readback` · `wait` · `commit` · `handoff` · `noop`
- `say`: the Hinglish line for your TTS
- `proposal`: `{proposal_id, amount_inr, pay_date, mode}`
- `commit`: the saved Ledger row
- `handoff_case`, `reason`, `audit`

## LenderConfig

| Field | Default | Effect |
|---|---|---|
| `lender_name`, `agent_name` | demo values | Used in the opening line |
| `language` | `"hinglish"` | Reserved; the rules are Hinglish today |
| `allowed_modes` | `("UPI","CASH","BANK")` | Other modes trigger the limit policy |
| `min_amount_inr` / `max_amount_inr` | `1` / `1e7` | Amount limits |
| `max_horizon_days` | `365` | Furthest allowed pay date |
| `on_limit_violation` | `"handoff"` | `"handoff"` opens a case; `"reject"` asks the borrower again |
| `extra_handoff_keywords` | `{}` | e.g. `{"hardship": ["bimaar hoon"]}` on top of the built-in rules |
| `webhook_url`, `webhook_secret` | `None` | Signed event POSTs |

## Events

Event types: `promise.committed`, `promise.changed` (a follow-up call replaced an open promise after a fresh read-back and yes), `handoff.opened`, `handoff.taken_over`.

- Pass `on_event=callable` for in-process delivery.
- Set `webhook_url` to get a JSON POST `{type, created_at, data}`. With `webhook_secret`, it carries `X-WadaPakka-Signature: sha256=<hex HMAC of the body>`. Verify it with `wadapakka.sign(body, secret)`.

## Adapters

- **Any stack:** `wadapakka.adapters.guard_transcript(layer, session_id, account_id, text, is_final=..., speak=tts_fn, on_handoff=transfer_fn)` ignores partials and routes the reply.
- **Pipecat:** `examples/pipecat_processor.py`, a `FrameProcessor` between STT and TTS.
- **LiveKit Agents:** `examples/livekit_agent.py`, which hooks final user transcripts.
- **Any telephony (Exotel / Twilio / Plivo / dialer):** `examples/telephony_webhook.py`, a 20-line `/turn` endpoint.

The Pipecat, LiveKit and telephony files are **illustrative and not run in CI**, because those frameworks aren't installed here and their APIs change often. The core `Layer` and `guard_transcript` are covered by `tests/test_sdk.py`.

## Hosted REST mode

If you're not on Python, use the same engine over HTTP at `https://wadapakka.onrender.com`. It runs on Render's free tier, so the first request after it has been idle can take about a minute.

| Endpoint | Purpose |
|---|---|
| `POST /api/session` | Start a call (returns the memory-aware opening prompt) |
| `POST /api/turn-text` `{session_id, transcript}` | One borrower turn → read-back / handoff |
| `POST /api/confirm` `{session_id, proposal_id, accepted}` | Explicit yes / no |
| `POST /api/turn` (multipart audio) | Gnani Prisma STT + the same flow |
| `GET /api/ledger`, `GET /api/accounts/{id}/promises` | Saved promises and outcomes |
| `GET /api/handoffs`, `POST /api/handoffs/{id}/takeover`, `POST /api/handoffs/{id}/resolve` | Handoff desk |
| `GET /api/eval/adversarial` | Run the adversarial eval live |

The hosted demo serves one synthetic account (`synthetic-ravi-kumar`). Multi-tenant hosting with per-lender keys is on the roadmap.

## Limits (honest)

- Text-in / text-out. It assumes your STT gives final transcripts, and audio barge-in stays in your stack (or the demo's live mode).
- Rules are Hinglish-first. Other languages need their own normalizer rules.
- The package installs the engine as top-level modules (`app`, `normalizer`, ...). A namespaced `wadapakka.core` is planned before a PyPI release.
- Use synthetic data for demos. The Ledger stores transcripts, so treat a production database as PII.
