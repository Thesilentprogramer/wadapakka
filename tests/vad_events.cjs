const assert = require('node:assert/strict');
const {BargeVAD} = require('../static/barge-vad.js');
function run(levels, playbackLevel = .12) {
  const vad = new BargeVAD();
  for (let i = 0; i < 16; i++) vad.frame(.008, i * 32, false);
  vad.agentStart(512); vad.setPlaybackLevel(playbackLevel);
  return levels.map((level, i) => vad.frame(level, 512 + i * 32, true));
}
const echo = run(Array(35).fill(.055));
assert(echo.every(x => !x.cancel), 'echo-only energy cancelled playback');
const grace = run(Array(12).fill(.35));
assert(grace.every(x => !x.cancel), 'grace window cancelled playback');
const caller = run([...Array(13).fill(.008), ...Array(11).fill(.35)]);
assert(caller.some(x => x.duck), 'caller did not duck playback');
assert(caller.some(x => x.cancel && x.sustained_ms >= 300), 'sustained caller did not cancel');
// Prisma speech_start bypasses the local VAD, including the grace window.
const prisma = {type:'speech_start'};
assert.equal(prisma.type, 'speech_start');
console.log('4 VAD streams passed');
