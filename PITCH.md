# WadaPakka: Solution Pitch (1 page)

**Built by Shubham Indulkar (solo) for the Great Indian AI Internship Challenge by Gnani.ai**

## Problem
Voice agents on Indian loan-collection calls hear promises to pay in Hinglish, like "dhai hazaar, parso, UPI se". A transcription or parsing mistake ("sawa teen sau" heard as 3500, or "kal" read as the wrong day) silently writes the wrong promise to the ledger. Echo from the agent's own voice also triggers false interruptions. The result is wrong follow-ups, angry borrowers and broken trust.

## Solution
WadaPakka is a reliability layer that sits between **Gnani Prisma STT** and **Gnani Timbre TTS**:
1. **Normalize**: Hinglish amounts and relative dates become exact values, and unclear ones like "kal" are flagged.
2. **Verify**: Prisma returns no confidence score, so every critical slot (amount, date, payment method) is confirmed by default.
3. **Read back**: the agent repeats the promise in Timbre's voice (Poorvi, hi-en).
4. **Confirm**: the promise is saved only after the borrower says "haan". A correction sends it back to the slot step.
5. **Commit once**: an idempotent ledger blocks duplicate writes.
6. **Hand off**: difficult or upset callers go to a human desk with a short brief.
7. **Observe**: every turn is logged with its transcript, slots, decision and latency.

**Live mode**: Prisma streaming over WebSocket, with real interruptions that stop Timbre's speech. A loud sound only lowers the agent's volume. The agent stops only after sustained speech or Prisma's speech-start signal, with noise calibration.

## Measured results (real Gnani APIs)
- Final transcript about 700 ms after the caller stops speaking
- First Timbre audio byte in about 1.0–1.27 s
- Scripted interruption stops the agent within 266 ms
- Live audio test: 2 of 3 promises read correctly. The miss ("sawa teen sau" heard as 3500) is exactly the kind of error read-back and confirm catch before it's written.

## Gnani models used
Prisma STT v3 (REST `/stt/v3` and streaming `wss://.../stt/v3/stream`), Timbre TTS v2.5.

## Stack
FastAPI, Python, React with Vite and TypeScript, WebSockets, and an AudioWorklet that handles voice detection and interruptions.

## Why it matters
Gnani's models already understand Indian speech. WadaPakka makes what an agent *does* with that speech safe: no promise is written until the borrower has heard it back and agreed.
