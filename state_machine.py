"""PTP conversation state machine.

States:
  GREETING -> COLLECTING -> CONFIRMING -> WRITTEN
                                    -> CLARIFY -> COLLECTING
  any -> HANDOFF
  any -> REFUSED
"""

from __future__ import annotations

from enum import Enum


class State(str, Enum):
    GREETING = "GREETING"
    COLLECTING = "COLLECTING"
    CONFIRMING = "CONFIRMING"
    READBACK_PENDING = "READBACK_PENDING"
    AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
    COMMITTING = "COMMITTING"
    COMMIT_FAILED = "COMMIT_FAILED"
    CLARIFY = "CLARIFY"
    WRITTEN = "WRITTEN"
    HANDOFF = "HANDOFF"
    REFUSED = "REFUSED"


TRANSITIONS = {
    State.GREETING: {State.COLLECTING, State.HANDOFF, State.REFUSED},
    State.COLLECTING: {State.CONFIRMING, State.READBACK_PENDING, State.CLARIFY, State.COLLECTING, State.HANDOFF, State.REFUSED},
    State.CONFIRMING: {State.AWAITING_CONFIRMATION, State.READBACK_PENDING, State.CLARIFY, State.COLLECTING, State.HANDOFF, State.REFUSED},
    State.READBACK_PENDING: {State.AWAITING_CONFIRMATION, State.CLARIFY, State.HANDOFF},
    State.AWAITING_CONFIRMATION: {State.COMMITTING, State.READBACK_PENDING, State.CLARIFY, State.HANDOFF},
    State.COMMITTING: {State.WRITTEN, State.COMMIT_FAILED, State.HANDOFF},
    State.COMMIT_FAILED: {State.COMMITTING, State.CLARIFY, State.HANDOFF},
    State.CLARIFY: {State.COLLECTING, State.CONFIRMING, State.READBACK_PENDING, State.HANDOFF, State.REFUSED},
    State.WRITTEN: set(),
    State.HANDOFF: set(),
    State.REFUSED: set(),
}


def can_move(current: State, nxt: State) -> bool:
    return nxt in TRANSITIONS[current]
