"""Play streamed agent PCM while injecting a caller WAV mid-utterance."""
import argparse
import asyncio
import base64
import json
import shutil
import time
import wave
from pathlib import Path

import httpx
import websockets


async def run(path: Path, base: str, audible: bool = False):
    with wave.open(str(path), 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise SystemExit('WAV must be 16 kHz mono 16-bit PCM')
        caller = wav.readframes(wav.getnframes())
    async with httpx.AsyncClient() as client:
        response = await client.post(base + '/api/session')
        response.raise_for_status()
        sid = response.json()['session']['id']
    uri = base.replace('http://', 'ws://').replace('https://', 'wss://') + '/api/live/' + sid
    player = None
    playback_failed = False
    if audible and shutil.which('ffplay'):
        player = await asyncio.create_subprocess_exec('ffplay', '-loglevel', 'quiet', '-nodisp', '-autoexit',
                   '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:0', stdin=asyncio.subprocess.PIPE)
    first_audio = asyncio.Event()
    got_interrupt = asyncio.Event()
    onset = prisma = interrupted = None
    source = reaction = None
    async with websockets.connect(uri, max_size=8_000_000) as socket:
        async def receive():
            nonlocal prisma, interrupted, source, reaction, playback_failed
            async for raw in socket:
                event = json.loads(raw)
                kind = event.get('type')
                if kind == 'agent_audio':
                    first_audio.set()
                    if player and player.stdin and not playback_failed:
                        try:
                            player.stdin.write(base64.b64decode(event['audio']))
                            await player.stdin.drain()
                        except (BrokenPipeError, ConnectionResetError):
                            playback_failed = True
                elif kind == 'speech_start':
                    prisma = time.perf_counter()
                elif kind == 'interrupted':
                    interrupted = time.perf_counter()
                    got_interrupt.set()
                    source, reaction = event.get('source'), event.get('reaction_ms')
                elif kind == 'error':
                    print('Error:', event.get('message'))
                    break
        reader = asyncio.create_task(receive())
        async def silence():
            while not first_audio.is_set():
                await socket.send(b'\0' * 1024)
                await asyncio.sleep(.032)
        await asyncio.wait_for(silence(), 30)
        await asyncio.sleep(.45)
        onset = time.perf_counter()
        for offset in range(0, len(caller), 1024):
            await socket.send(caller[offset:offset+1024].ljust(1024, b'\0'))
            await asyncio.sleep(.032)
            if interrupted:
                break
        await socket.send(json.dumps({'type':'speech_end'}))
        if not interrupted:
            try:
                await asyncio.wait_for(got_interrupt.wait(), 8)
            except asyncio.TimeoutError:
                pass
        reader.cancel()
    if player:
        if player.stdin:
            player.stdin.close()
        try:
            await asyncio.wait_for(player.wait(), 2)
        except asyncio.TimeoutError:
            player.kill()
    print('Agent audio received:', first_audio.is_set())
    if audible: print('Local audible playback:', 'unavailable' if playback_failed or (player and player.returncode) else 'started')
    print('Interruption source:', source or 'none')
    print('Caller WAV onset → interruption:', round((interrupted-onset)*1000) if interrupted else '—', 'ms')
    print('Prisma speech_start → interruption (client observed):', round((interrupted-prisma)*1000) if prisma and interrupted else '—', 'ms')
    print('Server reaction:', reaction if reaction is not None else '—', 'ms')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('wav', type=Path)
    parser.add_argument('--base', default='http://127.0.0.1:8001')
    parser.add_argument('--audible', action='store_true', help='Play agent PCM with ffplay')
    args = parser.parse_args()
    asyncio.run(run(args.wav, args.base, args.audible))
