# WadaPakka reliability v2 — grilled build plan

**Scope:** plan only; synthetic borrowers; target November 15, 2026 EOD IST. Working decisions below are adopted for the two-day build unless Shubham changes an open decision. No production collection claim follows from this demo.

## Open decisions for Shubham

1. **Should the existing “naive” comparison still write real rows?** **Recommend:** keep the before/after display, but make naive writes a simulated result outside the guarded Ledger. Alternatives: leave its current direct write (undermines “every Ledger commit is guarded”); remove the comparison (loses a useful demo). This is a product/demo call because it changes the meaning of the existing comparison.
2. **What is the uniqueness boundary for an open promise?** **Recommend:** one open promise per synthetic `account_id`, across sessions; use the current synthetic account as the v2 fixture. Alternatives: per session (allows a second call to write a conflicting promise); a borrower identity inferred from speech (unreliable and unnecessary for synthetic data). The account policy needs confirmation before any later multi-account use.

## Codebase facts that settle factual questions

| Question | Answer and source |
| --- | --- |
| Where do commitments happen now? | `_layer_turn` and `_naive_commit` in [`app.py`](../app.py) call `Ledger.commit`; `/api/confirm` converts a button press to a typed `haan`. `Ledger.commit` in [`idempotency.py`](../idempotency.py) deduplicates only the same session, amount, date, and mode. A changed amount/date gets a new key. |
| What is the existing conversation flow? | [`state_machine.py`](../state_machine.py) has `COLLECTING`, `CLARIFY`, `CONFIRMING`, `WRITTEN`, `HANDOFF`, `REFUSED`. `_layer_turn` in [`app.py`](../app.py) reads back before writing, but treats a plain positive phrase in `CONFIRMING` as sufficient and constructs success speech immediately after `commit`. |
| How is live read-back protected? | `ReadbackGate` and `live_socket` in [`streaming.py`](../streaming.py) require generated, completed, uninterrupted playback before live confirmation. Streaming checks this gate outside `_handle_turn`; REST/typed turns have no playback acknowledgement. |
| Does Prisma provide confidence or word spans? | No usable confidence, n-best, or word timestamps are observed; see [`gnani_stt.py`](../gnani_stt.py), [`verifier.py`](../verifier.py), and [`docs/api_notes.md`](api_notes.md). `_record_turn` in [`app.py`](../app.py) logs `confidence: None`. Evidence must therefore use the final transcript text plus turn/segment identifiers and character offsets, not fabricated audio timing. |
| What does Eval measure today? | `run_eval` in [`app.py`](../app.py) scores eight paired, hand-authored *single-turn* text triples from [`fixtures/eval_cases.json`](../fixtures/eval_cases.json). It does not exercise the full conversation or actual commits. [`docs/eval_results.md`](eval_results.md) warns that seven paired inputs differ and the score is not measured STT uplift. |
| Where are the panels? | Turn comparison, Ledger, Handoff, and fixture Eval appear in [`web/src/components/TurnPanel.tsx`](../web/src/components/TurnPanel.tsx) with requests in [`web/src/hooks/useTurnCall.ts`](../web/src/hooks/useTurnCall.ts). Live Eval and Ledger appear in [`web/src/components/LivePanel.tsx`](../web/src/components/LivePanel.tsx); live socket handling is in [`web/src/hooks/useLiveCall.ts`](../web/src/hooks/useLiveCall.ts). |
| What is retained? | `sessions`, `ledger`, and `turn_log` are process memory in [`app.py`](../app.py). Restart erases them, as [`README.md`](../README.md) states. `detect_handoff` in [`handoff.py`](../handoff.py) currently recognizes human request and a small distress vocabulary, not wrong-person, hardship, or dispute as separate reasons. |

## Feature 1: code-guarded promise commit

| Decision question | Recommended working answer | Alternatives considered |
| --- | --- | --- |
| Which path is allowed to write? | One server-side `commit_confirmed_promise` function is the only caller of guarded Ledger insert. Route layer text, REST audio, live socket, and `/api/confirm` through it. The naive comparison reports a hypothetical write. | Guard only the layer UI (other routes bypass it); let the browser declare a successful write. |
| What is a commit candidate? | A versioned proposal with positive amount in paise, ISO payment date, mode, account ID, source turn IDs, and canonical read-back text. Freeze its proposal ID and values while waiting for confirmation. | Use mutable `session.slots` (a mid-call correction can be written under an earlier yes); rely only on a hash of fields (does not bind the read-back event). |
| What counts as clear consent? | A final affirmative utterance with no negation or new amount/date, tied to the current proposal ID, after a complete read-back. In live mode require `ReadbackGate.can_confirm()`. A typed button is an explicitly labeled demo acknowledgement, recorded as `source=ui`, never counted as spoken consent in Eval. | Accept `haan` anywhere; infer consent from silence; require the payment mode to be repeated. |
| What if the caller corrects or barges in? | Invalidate proposal version and playback gate; extract corrected values, ask for missing or conflicting slots, and issue a fresh full amount/date/mode read-back. An old or late `haan` cannot commit. | Patch the current proposal after read-back; allow a yes during playback. |
| What if the ledger write fails or conflicts? | Return structured `write_failed`, `duplicate`, or `open_promise_conflict`; do not enter `WRITTEN` or speak “promise noted” until a successful write or exact duplicate is verified. Exact duplicate can say “already recorded.” Conflicting open promise goes to review/Handoff, with no second row. | Optimistically acknowledge before insert; overwrite the previous promise; create a second row for a new field hash. |

### Data and state

- Add stable synthetic `account_id` to each session. Store `proposal = {id, version, amount_paise, pay_date, mode, readback_text, readback_turn_id, readback_status, expires_at}` and `confirmation = {turn_id, transcript, source, proposal_id}`. Keep `slots` for display, but never commit directly from mutable slots.
- Ledger row: `promise_id`, `account_id`, `session_id`, canonical fields, `status=OPEN`, `proposal_id`, `confirmed_at`, `confirmation_evidence_id`, `created_at`. Enforce unique open `account_id`; use a lock or a tiny SQLite transaction/unique index to make the check and insert atomic. For this deadline, prefer SQLite over process memory for Ledger only, with a disposable local demo DB. Exact same proposal retry returns its prior row; different open fields return a conflict.
- Evidence row: `evidence_id`, `session_id`, `turn_id`/Prisma `segment_id` if present, final transcript, start/end *character* offsets for the affirmative span, proposal/read-back IDs, source (`speech` or `ui`), and observed timestamp. Retain the whole synthetic turn alongside the span so an auditor can inspect context. Never describe character offsets as audio timestamps.
- Proposed transition chain: `COLLECTING/CLARIFY → READBACK_PENDING → AWAITING_CONFIRMATION → COMMITTING → WRITTEN`. `READBACK_PENDING` becomes `AWAITING_CONFIRMATION` after playback acknowledgement; a typed demo path records its explicit UI acknowledgement. Corrections return to `CLARIFY`; barge-in returns to `READBACK_PENDING` with a new proposal; failure returns to a retryable `COMMIT_FAILED`; conflict routes to `HANDOFF`. `WRITTEN`, `HANDOFF`, and `REFUSED` stay terminal. A valid partial payment is a promise for the stated amount, not a refusal.
- Reply check: construct a success prompt only from a verified row returned by the commit function. On exception, timeout, or conflict, give a neutral “I could not record that yet” message and show the same status in the UI. Never synthesize a success prompt before the write result.

### API contract

- Keep `POST /api/session`, `POST /api/turn-text`, `POST /api/turn`, `POST /api/confirm`, and `WS /api/live/{session_id}`; their responses gain `proposal`, `commit_status`, `evidence_id`, and `audit_status`. `/api/confirm` accepts `proposal_id` and rejects stale or out-of-state confirmations with 409. The live socket sends read-back completion/interrupt events tied to proposal ID.
- `GET /api/ledger` returns only actual guarded rows plus status/evidence reference. `GET /api/ledger/{promise_id}/evidence` returns the synthetic transcript span and read-back linkage. `GET /api/session/{id}` exposes the current proposal and audit result.
- Errors are explicit machine-readable codes: `readback_incomplete`, `confirmation_ambiguous`, `stale_proposal`, `open_promise_conflict`, `ledger_unavailable`. Route all write attempts through the same server guard; API handlers may map these to HTTP 409/503 without inventing a success message.

## Feature 2: adversarial Eval harness

| Decision question | Recommended working answer | Alternatives considered |
| --- | --- | --- |
| What should be evaluated? | Replay full synthetic multi-turn conversations through the same public text-turn contract and guarded commit path, in isolated in-memory/temporary DB state. Keep the old paired-text fixture score separately labeled. | Score only parser triples; mutate global demo sessions during Eval; call live vendors for every required test. |
| How many cases and what is gold? | Eight scripted personas below, each with expected per-turn state, final ledger rows, handoff reason, and allowed speech. Freeze `today` and dates in each scenario. | Random unguided utterances with subjective grading; a single aggregate score. |
| How should barge-in be tested without live vendor dependence? | Feed a deterministic fake live event sequence into `ReadbackGate` (read-back starts, interruption, late yes, replay, completion) and assert no write until a fresh complete read-back plus consent. Optional real Prisma/Timbre smoke remains separate. | Treat typed text as proof of real-time barge-in timing. |
| What constitutes a pass? | Four named checks per scenario: exact promise fields when a valid promise exists; zero writes without a valid confirmation; hardship/wrong-person handoff; zero false refusal of a valid promise. Also assert no false success speech after failed write. Report each denominator and case failures, not only an overall percentage. | Binary “case passed” without diagnostics; use the previous 8/8 parser figure as an end-to-end reliability claim. |

| Persona | Scripted turns and expected result |
| --- | --- |
| Angry | “Stop bothering me” then a clear ₹2,000/date/UPI promise, hears read-back, says yes. Exact one row, no false refusal. |
| Partial payer | “Only ₹300 of ₹2,500 on 15 November by UPI,” then yes. Save ₹300, not outstanding ₹2,500. |
| Hardship | “Job chali gayi, abhi nahi de sakta.” Handoff `hardship`, zero rows. |
| Wrong person | “Ravi yahan nahi; wrong number.” Handoff `wrong_person`, zero rows. |
| Dispute | “Yeh amount galat hai, statement bhejo.” Handoff `dispute`, zero rows. |
| Evasive | “Dekhenge, shayad kal.” Clarify/exit unconfirmed, zero rows. |
| AI disclosure | “Are you AI?” Agent gives a truthful short answer, then a valid promise/yes can proceed. No refusal or premature write. |
| Date change and barge-in | First proposal says 15 November; borrower interrupts read-back with “16 November,” then a late yes arrives. Old proposal must not write; fresh full read-back plus yes yields exactly one row for the 16th. |

Use one clear date anchor, such as 2026-11-13, and explicit ISO dates in gold. Add negative variants within cases for “haan, but 300,” negated yes, repeated segment ID, two concurrent confirmations, and injected Ledger failure. Test both Latin Hinglish and Devanagari forms where they affect the expected parse. `GET /api/eval/adversarial` should return case-level checks, observed transitions, row count, errors, and aggregate numerators/denominators; running it must not alter the visible demo ledger. Keep `GET /api/eval` as the legacy parser demonstration and label it accordingly in both UIs.

## Feature 3: said-vs-saved audit

| Decision question | Recommended working answer | Alternatives considered |
| --- | --- | --- |
| When does audit run? | After every final borrower turn that changes slots, after a commit attempt, and at call end; expose a final per-call audit. Implement one reusable `audit_session` function called by REST, typed, and live end/close paths. | Only run when the Ledger tab is opened; compare once before commit. |
| What is compared? | Canonical amount/date/mode from the final Prisma transcript, latest frozen proposal, confirmation read-back, and saved Ledger row. Compare numbers as paise and dates as ISO dates; preserve raw phrases and turn IDs. | Literal string diff (`15 tareekh` vs `pandrah` is noisy); compare only the most recent turn. |
| How are conflicts handled? | If multiple plausible numbers/dates exist, or a later correction disagrees, set `audit_status=NEEDS_REVIEW` and `promise_status=UNCONFIRMED`; block commit until clarified and freshly confirmed. An actual confirmed row whose post-call audit conflicts is flagged `REVIEW_REQUIRED` without silently changing its history. | Auto-pick the first number; alter a committed row; label a model confidence score that does not exist. |
| What is “low confidence”? | A rule-based `uncertain` reason: parser ambiguity, dual-pass disagreement when available, missing date anchor, conflicting turns, or STT substitution suspected from later correction. Display “uncertain parsing,” never a numeric Prisma confidence. | Show a made-up probability; treat dual-pass agreement as proof of correctness. |

Audit record: `audit_id`, `session_id`, `account_id`, `run_at`, `source_turn_ids`, `transcript_snippets`, `parsed_candidates`, `proposal_snapshot`, `ledger_snapshot`, `field_diffs`, `reasons`, `status`. Cases like “₹3,000” versus “₹300” must be caught when both forms appear across turns, dual passes, or confirmation correction; the single transcript alone cannot reveal a misheard spoken number. “15 tareekh” versus “pandrah” should normalize to the same day only with an explicit month/year anchor; otherwise request the full date. If the caller ends the call while clarification is pending, retain an unconfirmed proposal/audit record and zero open Ledger rows. An `UNCONFIRMED` proposal is not a committed promise.

Add `POST /api/session/{id}/end` for explicit turn-based end and `GET /api/session/{id}/audit`; live disconnect invokes the same audit routine. `GET /api/audits?status=...` supports the desk. Make end idempotent so a socket close and explicit End do not duplicate audit records. Handoff for audit review includes the discrepancy and source transcript snippets; it does not imply a borrower accepted a payment promise.

## UI changes by panel

| Panel | Planned changes |
| --- | --- |
| Eval | Separate “legacy parser fixtures” from “adversarial conversations.” Show eight persona rows and four metric numerators/denominators, expected versus observed state, failing turn, and a direct link to the synthetic audit. Label spoken versus typed confirmation and optional live-audio smoke clearly. Update both [`TurnPanel.tsx`](../web/src/components/TurnPanel.tsx) and [`LivePanel.tsx`](../web/src/components/LivePanel.tsx), which currently each render Eval. |
| Ledger | Display only actual guarded commits with amount/date/mode, `OPEN` or review status, confirmation source, and evidence link; show unconfirmed proposals in a separate queue. Show `duplicate`, `conflict`, and `write failed` distinctly. The existing naive comparison column becomes “would write,” with no real row. Fix the unconditional success status in `useTurnCall.confirm` and the `WRITTEN` status handling in `useLiveCall` to use `commit_status`/verified row. |
| Handoff desk | Add reason badges for hardship, wrong person, dispute, and audit conflict; show last relevant transcript, unresolved slot candidates, read-back status, and audit discrepancy. Keep a zero-write marker for safety cases. No human-action workflow is needed for this demo. |

## Test and verification plan

1. **Pytest unit tests:** consent classifier (affirmative, negation, mixed yes plus correction, empty/late yes), proposal version invalidation, read-back completion/interruption, amount/date canonicalization, evidence character span, one-open-promise guard, exact duplicate, conflicting amount/date, and injected DB failure. Assert each rejected path has zero success text and zero new rows.
2. **Pytest API tests:** call `/api/session`, turn endpoints, `/api/confirm` with proposal ID, `/api/session/{id}/end`, `/api/ledger`, `/api/audits`; cover stale proposal 409, wrong person/hardship handoff, and actual row/evidence consistency. Use temporary isolated storage, never the running demo state. Repeat confirmation and race two different proposals for the same account.
3. **Adversarial Eval:** run all eight synthetic scripts and verify every gold transition, final row count, field equality, handoff reason, no unconfirmed write, no false refusal, and no false success reply. Publish case-level JSON and a short reproducible result note. Run the existing `python -m pytest -q` and new harness before recording the video.
4. **Integration smoke:** one turn-based text flow and one optional live Prisma/Timbre call with synthetic speech, including a barge-in. Compare observed transcript and audit manually. Do not claim the deterministic Eval proves ASR accuracy or production consent capture. Build React with `cd web && npm run build` and inspect Eval/Ledger/Handoff paths.

## Two-day ordered build budget

Assume about **16 focused hours** total; preserve roughly 2 hours before the November 15 EOD deadline for integration surprises.

| Order | Work | Hours | Exit criterion |
| --- | --- | ---: | --- |
| 1 | Lock API/data contracts and create isolated synthetic fixtures | 1.0 | Proposal, evidence, audit, and status shapes written down in code comments/types. |
| 2 | Central guarded Ledger transaction, account uniqueness, failure codes | 2.5 | Concurrent conflicting attempts cannot produce two open rows. |
| 3 | Proposal state machine, consent parser, read-back linkage, reply check across text/REST/live | 3.5 | No path says “recorded” before verified insert; interrupted/stale yes is blocked. |
| 4 | Said-vs-saved audit and call-end hooks | 2.0 | Ambiguous/conflicting fields stay unconfirmed; per-call audit is retrievable. |
| 5 | Eight conversation scripts, scorer, pytest failure injection/races | 2.0 | Case-level metrics reproducible with isolated state. |
| 6 | Eval, Ledger, Handoff UI and response-status fixes | 2.0 | All three panels show real states and evidence. |
| 7 | Full pytest, frontend build, synthetic live smoke, fixes, video rehearsal | 1.0 | Demo path passes and claims match results. |
| **Total** | | **14.0** | **2.0-hour contingency remains.** |

## Demo video script (about 90 seconds)

1. Show synthetic account and state the rule: a promise needs a complete amount/date read-back and a clear yes.
2. In Eval, run the eight scripted personas; show named denominators and the wrong-person/hardship zero-write outcomes. Explain that these are deterministic synthetic conversations.
3. In the turn panel, enter “₹3,000 on 15 November by UPI.” Show proposal and spoken/Timbre read-back. Correct it to “₹300 on 16 November” during read-back (or run the deterministic barge-in script), then send a late “haan.” Show no Ledger row and an audit discrepancy.
4. Hear the new full read-back, give a clear yes, and show one guarded Ledger row with transcript evidence. Repeat yes and attempt a conflicting second promise; show duplicate/conflict with still one open row.
5. Trigger an injected write failure in the deterministic script; show neutral failure response and zero “promise noted” speech. End at Handoff desk with discrepancy/hardship context. If live vendor audio is shown, label it a separate smoke demonstration.

## Risks and cuts if time runs short

- **Highest risk: live path and REST diverge.** Implement the server guard and reply check first; use the same proposal/commit function from both. If time runs short, keep live read-back gate but demonstrate the full adversarial flow through typed turns, clearly labeling the live barge-in test as simulated.
- **Prisma can misrecognize a number, and no confidence score is available.** Require the borrower to correct or affirm the spoken read-back. Audit detects disagreements visible in transcripts; it cannot infer a hidden audio truth from one bad transcript. Do not cut the confirmation or conflict guard.
- **UI breadth:** cut detailed audit drill-down styling and use a compact evidence drawer/JSON view. Keep status labels, failed-write feedback, and Handoff reasons.
- **Storage and deadlines:** SQLite for Ledger uniqueness is preferred; if SQLite integration overruns, use a process lock plus in-memory account index for the demo and prominently retain the restart limitation. Do not claim cross-process safety under that cut.
- **External service latency/availability:** deterministic text Eval and prerecorded synthetic audio carry the video. Real vendor calls are optional smoke only; do not change credentials or use real borrower data.
