"""Per-lender settings. Defaults reproduce the live WadaPakka demo behaviour."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class LenderConfig:
    lender_name: str = "WadaPakka Demo Finance"
    agent_name: str = "WadaPakka"
    language: str = "hinglish"
    allowed_modes: tuple[str, ...] = ("UPI", "CASH", "BANK")
    min_amount_inr: float = 1.0
    max_amount_inr: float = 10_000_000.0
    max_horizon_days: int = 365
    # Extra handoff keywords per reason, on top of the built-in rules in handoff.py.
    # Built-in reasons: hardship, dispute, wrong_person; anything else is stored as "other".
    extra_handoff_keywords: dict[str, list[str]] = field(default_factory=dict)
    # Outside the limits above, "handoff" opens a case for a human; "reject" asks again.
    on_limit_violation: str = "handoff"
    webhook_url: str | None = None
    webhook_secret: str | None = None
