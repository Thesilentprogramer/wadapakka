"""EXAMPLE, not run in CI (needs `pip install pipecat-ai`).

Where WadaPakka sits in a Pipecat pipeline:

    transport.input() -> STT (e.g. Gnani Prisma) -> WadaPakkaGuard -> TTS (e.g. Gnani Timbre) -> transport.output()

The guard consumes FINAL transcriptions only and emits the line to speak.
Promise writes happen inside the layer's guarded Ledger, never in your LLM.
Pipecat's API moves fast; check frame/class names against your installed version.
"""
from pipecat.frames.frames import Frame, TranscriptionFrame, TTSSpeakFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from wadapakka import Layer, LenderConfig, SQLiteStore

layer = Layer(config=LenderConfig(lender_name="Demo Finance", agent_name="Asha"),
              store=SQLiteStore("wadapakka.db"))


class WadaPakkaGuard(FrameProcessor):
    def __init__(self, session_id: str, account_id: str):
        super().__init__()
        self.session_id, self.account_id = session_id, account_id

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):          # final STT result, not interim
            decision = layer.on_turn(self.session_id, self.account_id, frame.text)
            if decision.say:
                await self.push_frame(TTSSpeakFrame(decision.say))
            if decision.action == "handoff":
                # e.g. SIP-transfer the call and show decision.handoff_case on the desk
                pass
            return                                         # transcript consumed by the guard
        await self.push_frame(frame, direction)

# pipeline = Pipeline([transport.input(), stt, WadaPakkaGuard("call-123", "synthetic-ravi-kumar"), tts, transport.output()])
