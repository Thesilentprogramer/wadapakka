# WadaPakka v3 deterministic Eval — 14 November 2026

Run: `python3 -m pytest -q` and `python3 -c 'from app import run_adversarial; print(run_adversarial()["passed"])'`.

Observed: **35 passed** in pytest; one Starlette deprecation warning. The adversarial endpoint returned `passed: true`: eight original personas, five v2 negative variants, and two new follow-up personas. The original v2 metrics remained exact fields **4/4**, zero unconfirmed writes **13/13**, hardship/wrong-person handoff **2/2**, and no false refusal **4/4**. The hardship, dispute, and wrong-person personas also each produced one persisted SQLite case with the expected reason.

| New follow-up persona | Observed result |
| --- | --- |
| Kept promise | Opening cited the saved ₹3,000 and 15 Nov date; a synthetic covering payment marked the old promise `kept`; one row. |
| Quiet amount change | Opening cited the saved promise; “haan, lekin 500” did not commit a replacement; one row remained `OPEN`. |

The replay uses synthetic text, isolated in-memory SQLite databases, and a fixed fixture date. It does not measure live Prisma recognition, Timbre playback timing, actual borrower consent, or real payment settlement. Payment records are synthetic. Broken/partial outcome checks use an injectable clock in pytest.
