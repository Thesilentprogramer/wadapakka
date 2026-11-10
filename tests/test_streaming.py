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
