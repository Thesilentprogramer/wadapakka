"""Prisma STT client.

Verified against https://docs.gnani.ai/api/STT/speech-to-text
and https://docs.gnani.ai/api/STT/stt-websocket

REST POST https://api.vachana.ai/stt/v3 returns:
  success, request_id, transcript, model,
  detected_language_code (prisma-v3.0, not with format=transliterate),
  processing_time, end_to_end_latency, truncated (only when cut short),
  output.literal (prisma-v2.5 only).

There is no confidence, n-best, or word-timestamp field on REST.
Streaming transcript messages also have no confidence field; is_final is always true.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

STT_REST_URL = "https://api.vachana.ai/stt/v3"
DEFAULT_MODEL = os.getenv("GNANI_STT_MODEL", "prisma-v3.0")


def _api_key() -> str:
    key = os.getenv("GNANI_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "GNANI_API_KEY is not set. Export it or copy .env.example."
        )
    return key


def transcribe_rest(
    audio_bytes: bytes,
    filename: str = "turn.wav",
    language_code: str = "hi-IN,en-IN",
    model: str = DEFAULT_MODEL,
    fmt: str = "transcribe",
    keyterms: str | None = '["EMI","किस्त","UPI","तारीख","हजार","रुपये"]',
    content_type: str = "audio/wav",
    timeout: float = 60.0,
) -> dict[str, Any]:
    """One-shot REST transcription of a clip up to 30 seconds."""
    data: dict[str, str] = {
        "model": model,
        "language_code": language_code,
        "format": fmt,
    }
    if keyterms:
        data["keyterms"] = keyterms
    headers = {"X-API-Key-ID": _api_key()}
    files = {"audio_file": (filename, audio_bytes, content_type)}
    with httpx.Client(timeout=timeout) as client:
        response = client.post(STT_REST_URL, headers=headers, files=files, data=data)
    body: dict[str, Any]
    try:
        body = response.json()
    except Exception:
        body = {"success": False, "raw": response.text}
    body["_http_status"] = response.status_code
    return body


def dual_pass(
    audio_bytes: bytes,
    filename: str = "turn.wav",
    language_code: str = "hi-IN,en-IN",
) -> dict[str, Any]:
    """Run format=transcribe and format=verbatim on the same clip.

    Prisma does not return n-best or confidence. Agreement between the two
    formatted transcripts is a fallback signal this layer invents.
    """
    written = transcribe_rest(
        audio_bytes, filename=filename, language_code=language_code, fmt="transcribe"
    )
    spoken = transcribe_rest(
        audio_bytes, filename=filename, language_code=language_code, fmt="verbatim"
    )
    return {"transcribe": written, "verbatim": spoken}
