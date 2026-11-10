# Build task: WadaPakka reliability layer (Gnani AI internship submission, deadline tonight 11:59 PM IST)

Read README.md first; it has the verified Gnani API facts and the architecture. This repo is a starter skeleton. Turn it into a polished, working, demo-ready prototype.

Context: a reliability/middleware layer between Gnani Prisma STT + Timbre TTS and agent logic. Prisma gives no usable confidence score, so the layer: normalises Hinglish/Indic amounts & dates (dhai hazaar, sawa teen sau, parso, agle somvaar; flags ambiguous "kal"), confirms every critical slot (amount, date, payment mode) via a Timbre read-back before committing, prevents duplicate writes on retries (idempotent ledger), and stops + hands off to a human with a one-line brief when asked. Demo use case: WadaPakka, a promise-to-pay closer for loan collections. Allowed APIs: only https://api.vachana.ai with header X-API-Key-ID (key in .env as GNANI_API_KEY; load it with python-dotenv; never print or commit it). Agent Builder / Inya is out of scope.

Do:
1. Create .venv, install requirements, make the app run with `uvicorn app:app --port 8000`.
2. Verify live calls work with the key: Prisma STT (POST /stt/v3) and Timbre TTS (POST /api/v1/tts/inference). Generate a few test audio clips with Timbre (Hinglish borrower lines, e.g. "main parso dhai hazaar UPI se de dunga") and transcribe them with Prisma to prove the end-to-end loop. Fix the clients to match real responses; log real response shapes (no secrets) into docs/api_notes.md.
3. Build a great single-page UI (static/): a side-by-side "Naive pipeline vs Reliability Layer" view for the same audio, mic button for live turns, agent voice playback, slot cards (amount/date/mode with states pending -> read back -> confirmed), the PTP ledger table, a handoff panel with the brief, and a per-turn observability timeline (transcript, normalised slots, decision, latency). Clean, modern, dark theme, looks good on a screen recording.
4. Eval: make `GET /api/eval` and a script `python eval.py` run on fixtures, and add an audio eval that uses Timbre-generated clips (optionally with added noise via ffmpeg) through real Prisma, reporting slot accuracy naive vs layer. Save results to docs/eval_results.md. Report honest numbers.
5. Add tests (pytest) for normalizer, verifier, idempotency, handoff. All passing.
6. Update README: one-paragraph pitch, architecture mermaid, how to run, eval results, Gnani models used (Prisma version, Timbre version/voice), and limitations.
7. Commit work in small git commits as you go.

Prioritise a working end-to-end demo over extra features. When done, print a short summary: what works, how to run, eval numbers, and anything broken.
