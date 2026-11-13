import pytest

from promise_guard import classify_consent, freeze_proposal


def _proposal(**overrides):
    values = {
        "proposal_id": "proposal-guard-test",
        "version": 1,
        "account_id": "synthetic-demo-ravi",
        "session_id": "session-guard-test",
        "amount_paise": 30_000,
        "pay_date": "2026-11-15",
        "mode": "UPI",
        "readback_text": "300 rupaye, 15 November, UPI",
        "readback_status": "complete",
    }
    values.update(overrides)
    return freeze_proposal(values)


def test_confirmation_rejects_a_different_payment_mode():
    result = classify_consent("yes cash", _proposal())
    assert result["status"] == "correction"


def test_confirmation_allows_repeating_the_frozen_mode():
    result = classify_consent("yes UPI", _proposal())
    assert result["status"] == "affirmative"


@pytest.mark.parametrize(
    "transcript",
    [
        "haan 300 ya 3000",
        "haan 300 or 3000",
        "haan 300 and 3000",
        "haan 300 aur 3000",
        "हाँ 300 या 3000",
        "हाँ 300 और 3000",
    ],
)
def test_confirmation_rejects_multiple_amount_candidates(transcript):
    result = classify_consent(transcript, _proposal())
    assert result["status"] == "correction"


def test_date_numbers_do_not_become_extra_amount_candidates():
    month_name = classify_consent("haan ₹300 on 15 November", _proposal())
    numeric_date = classify_consent("haan ₹300 on 15/11/2026", _proposal())

    assert month_name["status"] == "affirmative"
    assert numeric_date["status"] == "affirmative"


def test_confirmation_rejects_later_conflicting_date_candidate():
    result = classify_consent("haan 15 November or 16 November", _proposal())
    assert result["status"] == "correction"

