"""Timbre TTS client.

Verified against https://docs.gnani.ai/api/TTS/tts-inference
and https://docs.gnani.ai/api/TTS/tts-sse

POST https://api.vachana.ai/api/v1/tts/inference
  JSON: text, voice, model (timbre-v2.5 | timbre-v3.0), language, speed (0.85-1.15),
  audio_config {sample_rate, num_channels, sample_width, encoding, container}
  Success: 200 raw audio bytes (not JSON).

Endpoint docs document speed and Timbre v3.0 inline audio tags, not SSML.
The Speech APIs introduction mentions SSML; treat that as unverified against
the inference pages and do not send SSML in this skeleton.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

TTS_REST_URL = "https://api.vachana.ai/api/v1/tts/inference"
DEFAULT_MODEL = os.getenv("GNANI_TTS_MODEL", "timbre-v2.5")
DEFAULT_VOICE = os.getenv("GNANI_TTS_VOICE", "Poorvi")
DEFAULT_LANGUAGE = os.getenv("GNANI_TTS_LANGUAGE", "hi-en")


def _api_key() -> str:
    key = os.getenv("GNANI_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "GNANI_API_KEY is not set. Export it or copy .env.example."
        )
    return key


def synthesize(
    text: str,
    voice: str = DEFAULT_VOICE,
    model: str = DEFAULT_MODEL,
    language: str = DEFAULT_LANGUAGE,
    speed: float = 1.0,
    timeout: float = 60.0,
) -> tuple[bytes, dict[str, Any]]:
    payload = {
        "text": text,
        "voice": voice,
        "model": model,
        "language": language,
        "speed": speed,
        "audio_config": {
            "sample_rate": 16000,
            "num_channels": 1,
            "sample_width": 2,
            "encoding": "linear_pcm",
            "container": "wav",
        },
    }
    headers = {
        "X-API-Key-ID": _api_key(),
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=timeout) as client:
        response = client.post(TTS_REST_URL, headers=headers, json=payload)
    meta = {
        "http_status": response.status_code,
        "content_type": response.headers.get("content-type"),
        "voice": voice,
        "model": model,
        "language": language,
    }
    if response.status_code != 200:
        try:
            meta["error"] = response.json()
        except Exception:
            meta["error"] = response.text
        return b"", meta
    return response.content, meta
