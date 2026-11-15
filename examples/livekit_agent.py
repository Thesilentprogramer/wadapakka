"""EXAMPLE, not run in CI (needs `pip install livekit-agents`).

Where WadaPakka sits in a LiveKit voice agent: the user's FINAL transcript
goes to the layer, and the layer's `say` line goes to TTS. The promise is
written only by the layer's guarded Ledger after a read-back and a clear yes.
LiveKit's API moves fast; check event names against your installed version.
"""
from livekit.agents import AgentSession, JobContext, WorkerOptions, cli

from wadapakka import Layer, LenderConfig, SQLiteStore

layer = Layer(config=LenderConfig(lender_name="Demo Finance", agent_name="Asha"),
              store=SQLiteStore("wadapakka.db"))
ACCOUNT = "synthetic-ravi-kumar"   # look up from your CRM by the dialled number; synthetic here


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    session = AgentSession(stt=..., tts=..., vad=...)   # plug Gnani Prisma / Timbre or any provider
    call_id = ctx.room.name

    @session.on("user_input_transcribed")
    def on_transcript(ev):
        if not ev.is_final:
            return                                        # never act on partials
        decision = layer.on_turn(call_id, ACCOUNT, ev.transcript)
        if decision.say:
            session.say(decision.say)
        if decision.action == "handoff":
            ...                                           # transfer to a human; case is in layer.handoffs()

    await session.start(room=ctx.room)
    session.say(layer.opening_line(ACCOUNT))              # memory between calls


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
