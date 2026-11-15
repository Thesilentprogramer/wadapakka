"""Framework-agnostic glue. See examples/ for Pipecat and LiveKit sketches."""

from __future__ import annotations

from typing import Any, Callable

from ..layer import Decision, Layer


def guard_transcript(layer: Layer, session_id: str, account_id: str, text: str, *,
                     is_final: bool = True, speak: Callable[[str], Any] | None = None,
                     on_handoff: Callable[[Decision], Any] | None = None) -> Decision | None:
    """Drop this between any STT and any TTS.

    Interim transcripts are ignored (never act on partials). For a final
    transcript, the layer decides; ``speak`` gets the line for your TTS and
    ``on_handoff`` fires when a human should take the call.
    """
    if not is_final:
        return None
    decision = layer.on_turn(session_id, account_id, text)
    if speak and decision.say:
        speak(decision.say)
    if on_handoff and decision.action == "handoff":
        on_handoff(decision)
    return decision


__all__ = ["guard_transcript"]
