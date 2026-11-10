from streaming import ReadbackGate


def test_interrupted_readback_never_confirms_from_fake_events():
    gate = ReadbackGate()
    for event in ['readback_started', 'speech_start', 'cancel', 'audio_generated', 'playback_done']:
        if event == 'readback_started':
            turn = gate.begin(True)
        elif event in {'speech_start', 'cancel'}:
            gate.cancel()
        elif event == 'audio_generated':
            gate.generated_audio(turn)
        elif event == 'playback_done':
            assert not gate.complete(turn)
    assert not gate.can_confirm()
    next_turn = gate.begin(True)
    assert not gate.can_confirm()
    assert not gate.complete(next_turn)
    gate.generated_audio(next_turn)
    assert gate.complete(next_turn)
    assert gate.can_confirm()


def test_cancel_is_idempotent():
    gate = ReadbackGate()
    gate.begin(True)
    assert gate.cancel()
    assert not gate.cancel()
    assert not gate.can_confirm()

from streaming import accept_final


def test_fake_transcript_events_filter_echo_and_filler():
    events = [
        ('हाँ।', False, True, False, False),
        ('मसाले भी डालिए।', False, True, False, False),
        ('मैं 2500 रुपये UPI से दूंगा', True, False, False, False),
    ]
    assert [accept_final(*event) for event in events] == [False, False, True]
    assert not accept_final('haan', True, True, False, False)
    assert accept_final('haan', True, False, True, False)


def test_local_vad_fake_event_stream():
    import subprocess
    from pathlib import Path
    script = Path(__file__).parent / 'vad_events.cjs'
    result = subprocess.run(['node', str(script)], capture_output=True, text=True, check=True)
    assert '4 VAD streams passed' in result.stdout
