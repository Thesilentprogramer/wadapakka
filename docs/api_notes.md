# Live Gnani API observations

Verified 10 November 2026 with the local `.env` key. No key, request identifier or full response body is stored here. The clients send `X-API-Key-ID` only to `https://api.vachana.ai`.

| Call | Request | Observed response |
| --- | --- | --- |
| Timbre inference | `POST /api/v1/tts/inference`; `timbre-v2.5`, `Poorvi`, `hi-en`, WAV/16 kHz/mono | HTTP 200, `content-type: audio/wav`, raw bytes. First sample: 102,444 bytes. |
| Prisma STT | `POST /stt/v3` multipart `audio_file`, `model=prisma-v3.0`, `format=transcribe`, `language_code=hi-IN,en-IN` | HTTP 200 JSON. Observed keys: `success`, `request_id`, `transcript`, `model`, `processing_time`, `end_to_end_latency`, `detected_language_code`. |

First live loop: Timbre synthesized `Main parso dhai hazaar rupaye UPI se de dunga.` Prisma returned `मैं इन परसों 2,500 रुपये UPI से दे दूंगा।` The response reported `model: prisma-v3.0`, `detected_language_code: hi-IN`, `processing_time: 0.151s`, `end_to_end_latency: 0.153s`. `request_id` existed but is omitted here. No confidence, n-best or word scores were present. Three further live clips were generated and transcribed by `eval.py --audio`; see [eval results](eval_results.md).

The parser was updated for comma formatted amounts and the observed Devanagari `परसों`, `कैश`, and `बैंक` forms. The STT and TTS clients accept the observed JSON and raw audio response shapes. API failures return HTTP status and a short error in the demo; no secret is logged.

## Layer 2 streaming contract (verified against docs and live connection, 10 November 2026)

[Prisma realtime streaming](https://docs.gnani.ai/api/STT/stt-websocket) uses `wss://api.vachana.ai/stt/v3/stream`. The upgrade sends `X-API-Key-ID`, `language_code`, `model`, `format`, `x-sample-rate`, `x-vad-threshold`, `x-min-speech-ms`, `x-min-segment-ms`, and `x-min-silence-ms`. This demo sends `hi-IN`, `prisma-v3.0`, `transcribe`, `16000`, `0.55`, `100`, `100`, and `500` respectively. The docs say Prisma v3 can accept a comma-separated language list, but the **live endpoint rejected `hi-IN,en-IN`** with an error saying exactly one locale was required. The working live connection used `hi-IN`; this can still transcribe code-mixed Hindi/English in our smoke clip. This discrepancy needs checking with Gnani before using multiple languages in production.

Audio is headerless signed 16-bit little-endian mono PCM. Each binary frame is exactly 1,024 bytes (512 samples) sent every 32 ms at 16 kHz. `connected` confirms the configuration. `speech_start` signals barge-in (Prisma v3 adds `utterance_id`); `processing` marks segment capture; `transcript` provides `text`, `segment_id`, `utterance_id`, `is_final`, and `latency` (ms). The streaming transcript has no usable confidence score. The backend forwards only these data fields and never sends the API key to the browser.

[Timbre realtime streaming](https://docs.gnani.ai/api/TTS/tts-websocket) uses `wss://api.vachana.ai/api/v1/tts` with `X-API-Key-ID`. A JSON synthesis request contains `text`, `voice`, `model`, `language`, `speed`, and `audio_config`. This demo requests 16 kHz mono signed 16-bit **raw** PCM so each `audio` message's `data.audio` base64 bytes can be scheduled directly in the browser. `start`, `audio`, `complete`, and `error` are server message types. The [SSE endpoint](https://docs.gnani.ai/api/TTS/tts-sse) is an alternative `POST /api/v1/tts/sse` with `event: chunk`, `data.audio` base64; this implementation uses the WebSocket and falls back to REST inference if opening/streaming fails before any audio is delivered.

The local Python environment needs a current CA bundle for `wss://api.vachana.ai`; the proxy uses `certifi` with verification enabled. No key or full upstream response is logged.
