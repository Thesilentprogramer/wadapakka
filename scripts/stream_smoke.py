"""Stream a 16 kHz mono WAV to the local live socket at real-time cadence."""
import argparse
import asyncio
import json
import time
import wave
from pathlib import Path

import httpx
import websockets


async def run(path: Path, base: str) -> None:
    with wave.open(str(path), 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise SystemExit('WAV must be 16 kHz mono 16-bit PCM')
        data = wav.readframes(wav.getnframes())
    async with httpx.AsyncClient() as client:
        response = await client.post(base + '/api/session')
        response.raise_for_status()
        sid = response.json()['session']['id']
    uri = base.replace('http://', 'ws://').replace('https://', 'wss://') + '/api/live/' + sid
    started = time.perf_counter()
    processing = final = first_audio = None
    async with websockets.connect(uri, max_size=8_000_000) as socket:
        async def read_events():
            nonlocal processing, final, first_audio
            while True:
                event = json.loads(await socket.recv())
                kind = event.get('type')
                if kind == 'error':
                    print('Error:', event.get('message'))
                    return
                if kind == 'processing':
                    processing = time.perf_counter()
                elif kind == 'transcript':
                    final = time.perf_counter()
                    print('Transcript:', event.get('text'))
                    print('Prisma latency:', event.get('latency'), 'ms')
                    print('Speech end → final STT:', event.get('metrics', {}).get('end_to_final_ms'), 'ms')
                elif kind == 'tts_first_byte':
                    first_audio = time.perf_counter()
                    print('Speech end → first TTS byte:', event.get('end_to_audio_ms'), 'ms')
                    return
        reader = asyncio.create_task(read_events())
        for offset in range(0, len(data), 1024):
            frame = data[offset:offset + 1024].ljust(1024, b'\0')
            await socket.send(frame)
            await asyncio.sleep(.032)
        end = time.perf_counter()
        await socket.send(json.dumps({'type':'speech_end'}))
        for _ in range(32):
            await socket.send(b'\0' * 1024)
            await asyncio.sleep(.032)
        try:
            await asyncio.wait_for(reader, timeout=25)
        except asyncio.TimeoutError:
            print('Timed out waiting for transcript/TTS')
        print('WAV duration:', round(len(data)/32000, 2), 's')
        print('Client send end → STT final:', round((final-end)*1000) if final else '—', 'ms')
        print('Client send end → first TTS:', round((first_audio-end)*1000) if first_audio else '—', 'ms')
        print('Server processing → final:', round((final-processing)*1000) if processing and final else '—', 'ms')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('wav', type=Path)
    parser.add_argument('--base', default='http://127.0.0.1:8001')
    args = parser.parse_args()
    asyncio.run(run(args.wav, args.base))
