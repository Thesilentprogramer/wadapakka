/* 32 ms frames; shared by live UI and deterministic event-stream tests. */
class BargeVAD {
  constructor() { this.reset(); }
  reset() {
    this.frames = 0; this.floor = .008; this.elapsed = 0; this.voiced = 0;
    this.leakage = 0; this.utteranceAt = -Infinity; this.ducked = false;
  }
  agentStart(now) { this.utteranceAt = now; this.voiced = 0; this.ducked = false; }
  agentEnd() { this.utteranceAt = -Infinity; this.voiced = 0; this.ducked = false; this.leakage = 0; }
  setPlaybackLevel(level) { this.leakage = .5 * this.leakage + .5 * level; }
  frame(peak, now, playing, headphones = true) {
    this.elapsed += 32;
    if (this.elapsed <= 512) {
      this.floor = (this.floor * this.frames + peak) / (this.frames + 1);
      this.frames++;
    } else if (!playing && peak < this.floor * 2 + .015) {
      this.floor = .995 * this.floor + .005 * peak;
    }
    const threshold = Math.max(.035, this.floor + .025, playing ? this.floor + .025 + this.leakage * (headphones ? .55 : .85) : 0);
    this.voiced = peak > threshold ? this.voiced + 32 : 0;
    const grace = playing && now - this.utteranceAt < 400;
    const duck = playing && !grace && this.voiced >= 64;
    const cancel = playing && !grace && this.voiced >= 320;
    this.ducked = duck;
    return {duck, cancel, threshold, sustained_ms: this.voiced};
  }
}
if (typeof module !== 'undefined') module.exports = {BargeVAD};
if (typeof window !== 'undefined') window.BargeVAD = BargeVAD;
