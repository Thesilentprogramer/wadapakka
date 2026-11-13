from datetime import date, timedelta

from fastapi.testclient import TestClient

from app import app
from handoff import brief, detect_handoff
from idempotency import Ledger
from promise_guard import freeze_proposal
from normalizer import parse_amount_inr, parse_relative_date, parse_mode
from verifier import assess


def test_indic_amounts_and_dates():
    assert parse_amount_inr('dhai hazaar')[0] == 2500
    assert parse_amount_inr('sawa teen sau')[0] == 325
    assert parse_amount_inr('pachees sau')[0] == 2500
    assert parse_amount_inr('2500 rupaye parso')[0] == 2500
    assert parse_relative_date('parso', date(2026, 11, 10))[0] == date(2026, 11, 12)
    assert parse_relative_date('agle somvaar', date(2026, 11, 10))[0] == date(2026, 11, 16)
    assert parse_relative_date('kal', date(2026, 11, 10)) == (None, 'kal_ambiguous')
    assert parse_mode('UPI se')[0] == 'UPI'
    assert parse_amount_inr('मैं परसों 2,500 रुपये UPI से दे दूंगा।')[0] == 2500
    assert parse_relative_date('मैं परसों 2,500 रुपये UPI से दे दूंगा।', date(2026, 11, 10))[0] == date(2026, 11, 12)
    assert parse_amount_inr('12/11/2026')[0] is None


def test_verifier_requires_all_slots_and_readback():
    verdict = assess('dhai hazaar rupaye parso UPI se', today=date(2026, 11, 10))
    assert verdict['missing'] == []
    assert set(verdict['pending_confirm']) == {'amount_inr', 'pay_date', 'mode'}
    assert verdict['slots']['amount_inr'] == 2500
    ambiguous = assess('2500 rupaye kal UPI', today=date(2026, 11, 10))
    assert 'pay_date' in ambiguous['missing']


def test_ledger_retry_is_idempotent():
    ledger = Ledger(':memory:')
    proposal = freeze_proposal(proposal_id='proposal-1', version=1, session_id='session',
                               account_id='synthetic-test', amount_inr=2500,
                               pay_date='2026-11-12', mode='UPI', readback_text='2500, 2026-11-12, UPI',
                               readback_status='ui_acknowledged')
    confirmation = {'proposal_id': 'proposal-1', 'transcript': 'haan', 'source': 'ui', 'accepted': True}
    first = ledger.commit_confirmed_promise(proposal, confirmation)
    second = ledger.commit_confirmed_promise(proposal, confirmation)
    assert first['written'] and second['duplicate']
    assert len(ledger.rows) == 1


def test_handoff_and_brief():
    hit = detect_handoff('mujhe agent se baat karni hai')
    assert hit['handoff'] and hit['reason'] == 'human_requested'
    assert '2500' in brief({'amount_inr': 2500}, 'agent se baat', hit['reason'])


def test_handoffs_endpoint_lists_session_reason_and_brief():
    client = TestClient(app)
    sid = client.post('/api/session').json()['session']['id']
    response = client.post('/api/turn-text', json={
        'session_id': sid, 'transcript': 'mujhe aapke manager se baat karni hai'
    })
    assert response.status_code == 200
    rows = client.get('/api/handoffs').json()['rows']
    match = next(row for row in rows if row['session_id'] == sid)
    assert match['reason'] == 'human_requested'
    assert 'manager' in match['brief']


def test_confirmed_write_and_handoff_stop():
    client = TestClient(app)
    sid = client.post('/api/session').json()['session']['id']
    turn = client.post('/api/turn-text', json={'session_id': sid, 'transcript': 'dhai hazaar parso UPI se'}).json()
    assert turn['session']['state'] == 'CONFIRMING'
    assert client.get('/api/ledger').json()['rows'] == []
    proposal_id = turn['session']['proposal']['id']
    assert client.post('/api/confirm', json={'session_id': sid, 'proposal_id': proposal_id, 'accepted': True}).json()['commit']['written']
    assert client.post('/api/confirm', json={'session_id': sid, 'proposal_id': proposal_id, 'accepted': True}).json()['commit']['duplicate']
    sid2 = client.post('/api/session').json()['session']['id']
    handoff = client.post('/api/turn-text', json={'session_id': sid2, 'transcript': 'insaan se baat karao'}).json()
    assert handoff['session']['state'] == 'HANDOFF'
    assert handoff['handoff_brief']
    assert client.post('/api/turn-text', json={'session_id': sid2, 'transcript': '2500 parso UPI'}).status_code == 409


def test_clarification_keeps_previous_slots_until_readback():
    client = TestClient(app)
    sid = client.post('/api/session').json()['session']['id']
    first = client.post('/api/turn-text', json={'session_id': sid, 'transcript': '2500 rupaye kal UPI se'}).json()
    assert first['session']['state'] == 'CLARIFY'
    assert first['session']['slots']['pay_date'] is None
    target = date.today() + timedelta(days=2)
    second = client.post('/api/turn-text', json={'session_id': sid, 'transcript': target.strftime('%d/%m/%Y')}).json()
    assert second['session']['state'] == 'CONFIRMING'
    assert second['session']['slots']['amount_inr'] == 2500
    assert second['session']['slots']['pay_date'] == target.isoformat()
