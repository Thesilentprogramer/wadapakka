# Live Gnani API observations

Verified 10 November 2026 with the local `.env` key. No key, request identifier or full response body is stored here. The clients send `X-API-Key-ID` only to `https://api.vachana.ai`.

| Call | Request | Observed response |
| --- | --- | --- |
| Timbre inference | `POST /api/v1/tts/inference`; `timbre-v2.5`, `Poorvi`, `hi-en`, WAV/16 kHz/mono | HTTP 200, `content-type: audio/wav`, raw bytes. First sample: 102,444 bytes. |
| Prisma STT | `POST /stt/v3` multipart `audio_file`, `model=prisma-v3.0`, `format=transcribe`, `language_code=hi-IN,en-IN` | HTTP 200 JSON. Observed keys: `success`, `request_id`, `transcript`, `model`, `processing_time`, `end_to_end_latency`, `detected_language_code`. |

First live loop: Timbre synthesized `Main parso dhai hazaar rupaye UPI se de dunga.` Prisma returned `मैं इन परसों 2,500 रुपये UPI से दे दूंगा।` The response reported `model: prisma-v3.0`, `detected_language_code: hi-IN`, `processing_time: 0.151s`, `end_to_end_latency: 0.153s`. `request_id` existed but is omitted here. No confidence, n-best or word scores were present. Three further live clips were generated and transcribed by `eval.py --audio`; see [eval results](eval_results.md).

The parser was updated for comma formatted amounts and the observed Devanagari `परसों`, `कैश`, and `बैंक` forms. The STT and TTS clients accept the observed JSON and raw audio response shapes. API failures return HTTP status and a short error in the demo; no secret is logged.
