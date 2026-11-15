"""EXAMPLE, not run in CI: any telephony stack (Exotel, Twilio, Plivo, an in-house dialer).

Send each FINAL transcript to this tiny endpoint and speak back `say`.
Run: uvicorn examples.telephony_webhook:api --port 9000
"""
from fastapi import FastAPI
from pydantic import BaseModel

from wadapakka import Layer, SQLiteStore

layer = Layer(store=SQLiteStore("wadapakka.db"))
api = FastAPI()


class Turn(BaseModel):
    call_id: str
    account_id: str
    text: str


@api.post("/turn")
def turn(t: Turn):
    return layer.on_turn(t.call_id, t.account_id, t.text).as_dict()
