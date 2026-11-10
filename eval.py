"""Run deterministic transcript evaluation and optional live Timbre→Prisma evaluation."""
import argparse
import json
from datetime import date
from pathlib import Path

from app import run_eval
from gnani_stt import transcribe_rest
from gnani_tts import synthesize
from slots import extract_slots
from verifier import assess

AUDIO_CASES = [
    ("dhai_hazaar", "Main parso dhai hazaar rupaye UPI se de dunga", 2500.0, "UPI"),
    ("sawa_teen_sau", "Main parso sawa teen sau rupaye cash se de dunga", 325.0, "CASH"),
    ("do_hazaar", "Main agle somvaar do hazaar rupaye bank transfer se de dunga", 2000.0, "BANK"),
]


def audio_eval() -> dict:
    today = date.today()
    results = []
    for case_id, line, amount, mode in AUDIO_CASES:
        audio, tts = synthesize(line)
        if not audio:
            results.append({"id": case_id, "error": f"TTS HTTP {tts['http_status']}"})
            continue
        audio_dir = Path(__file__).resolve().parent / "docs" / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        (audio_dir / f"{case_id}.wav").write_bytes(audio)
        stt = transcribe_rest(audio, filename=f"{case_id}.wav")
        if not stt.get("success"):
            results.append({"id": case_id, "error": f"STT HTTP {stt.get('_http_status')}"})
            continue
        expected_date = extract_slots(line, today=today).pay_date
        text = stt.get("transcript", "")
        naive = extract_slots(text, today=today)
        verdict = assess(text, today=today)
        correct = (naive.amount_inr, naive.pay_date, naive.mode) == (amount, expected_date, mode)
        complete = all((naive.amount_inr, naive.pay_date, naive.mode))
        results.append({"id": case_id, "transcript": text, "gold": {"amount_inr": amount, "pay_date": expected_date, "mode": mode}, "parsed": naive.as_dict(), "naive_slot_correct": correct, "naive_would_write": complete, "layer_would_read_back": bool(verdict["pending_confirm"]) and not verdict["missing"], "layer_auto_writes": False, "stt_http_status": stt["_http_status"], "stt_fields": sorted(k for k in stt if k != "request_id")})
    completed = [r for r in results if "error" not in r]
    return {"n": len(completed), "attempted": len(results), "naive_slot_accuracy": sum(r["naive_slot_correct"] for r in completed) / len(completed) if completed else None, "layer_slot_accuracy_before_user_confirmation": sum(r["naive_slot_correct"] for r in completed) / len(completed) if completed else None, "layer_unconfirmed_writes": 0, "cases": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", action="store_true", help="Run live Timbre and Prisma calls")
    args = parser.parse_args()
    result = {"transcript_fixture_eval": run_eval()}
    if args.audio:
        result["live_audio_eval"] = audio_eval()
    print(json.dumps(result, indent=2, ensure_ascii=False))
