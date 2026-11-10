class LiveMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = [];
    this.position = 0;
    this.output = [];
    this.levelPeak = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const step = sampleRate / 16000;
    for (const sample of channel) {
      this.input.push(sample);
      this.levelPeak = Math.max(this.levelPeak, Math.abs(sample));
    }
    while (this.position + 1 < this.input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = this.input[index] * (1 - fraction) + this.input[index + 1] * fraction;
      this.output.push(Math.max(-32768, Math.min(32767, Math.round(value * 32767))));
      this.position += step;
    }
    const used = Math.floor(this.position);
    this.input.splice(0, used);
    this.position -= used;
    while (this.output.length >= 512) {
      const frame = new ArrayBuffer(1024);
      const view = new DataView(frame);
      for (let i = 0; i < 512; i++) view.setInt16(i * 2, this.output[i], true);
      this.output.splice(0, 512);
      this.port.postMessage({type:'pcm', frame, peak:this.levelPeak}, [frame]);
      this.levelPeak = 0;
    }
    return true;
  }
}
registerProcessor('live-mic', LiveMic);
