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
    CLARIFY = "CLARIFY"
    WRITTEN = "WRITTEN"
    HANDOFF = "HANDOFF"
    REFUSED = "REFUSED"


TRANSITIONS = {
    State.GREETING: {State.COLLECTING, State.HANDOFF, State.REFUSED},
    State.COLLECTING: {State.CONFIRMING, State.CLARIFY, State.COLLECTING, State.WRITTEN, State.HANDOFF, State.REFUSED},
    State.CONFIRMING: {State.WRITTEN, State.CLARIFY, State.COLLECTING, State.HANDOFF, State.REFUSED},
    State.CLARIFY: {State.COLLECTING, State.CONFIRMING, State.HANDOFF, State.REFUSED},
    State.WRITTEN: set(),
    State.HANDOFF: set(),
    State.REFUSED: set(),
}


def can_move(current: State, nxt: State) -> bool:
    return nxt in TRANSITIONS[current]
