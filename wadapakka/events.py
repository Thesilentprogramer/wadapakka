"""Event fan-out: an in-process callback and/or a signed webhook POST."""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
import urllib.request
from typing import Any, Callable

EVENT_TYPES = ("promise.committed", "promise.changed", "handoff.opened", "handoff.taken_over")


def sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class Emitter:
    def __init__(self, on_event: Callable[[dict[str, Any]], None] | None = None,
                 webhook_url: str | None = None, webhook_secret: str | None = None,
                 timeout_s: float = 3.0) -> None:
        self.on_event = on_event
        self.webhook_url = webhook_url
        self.webhook_secret = webhook_secret
        self.timeout_s = timeout_s

    def emit(self, event_type: str, data: dict[str, Any]) -> dict[str, Any]:
        event = {"type": event_type, "created_at": int(time.time()), "data": data}
        if self.on_event:
            try:
                self.on_event(event)
            except Exception:  # a broken callback must never block a call
                pass
        if self.webhook_url:
            threading.Thread(target=self._post, args=(event,), daemon=True).start()
        return event

    def _post(self, event: dict[str, Any]) -> None:
        body = json.dumps(event, default=str, ensure_ascii=False).encode()
        headers = {"Content-Type": "application/json", "User-Agent": "wadapakka-sdk"}
        if self.webhook_secret:
            headers["X-WadaPakka-Signature"] = sign(body, self.webhook_secret)
        req = urllib.request.Request(self.webhook_url, data=body, headers=headers, method="POST")
        try:
            urllib.request.urlopen(req, timeout=self.timeout_s).close()
        except Exception:
            pass
