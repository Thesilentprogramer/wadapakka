(() => {
  const $ = id => document.getElementById(id);
  let socket, stream, context, mic, input, sink, active = false;
  let scheduled = [], nextTime = 0, turnId = null, doneFromServer = false;
  let speechFrames = 0, quietFrames = 0, talking = false, bargeSent = false;
  const stats = {final: [], audio: [], barge: []};
  const timeline = $('liveTimeline');
  const agentEntries = new Map();
  function line(title, detail = '') {
    const li = document.createElement('li');
    const t = document.createElement('time'); t.textContent = new Date().toLocaleTimeString();
    const body = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = title;
    const span = document.createElement('span'); span.textContent = detail;
    body.append(strong, span); li.append(t, body); timeline.prepend(li);
    return {li, strong, span};
  }
  function status(text) { $('liveStatus').textContent = text; }
  function updateStats() {
    for (const [key, id] of [['final','liveFinal'],['audio','liveAudio'],['barge','liveBarge']]) {
      const values = stats[key];
      $(id).textContent = values.length ? Math.round(values.reduce((a,b)=>a+b,0)/values.length) + ' ms avg' : '—';
    }
  }
  function stopPlayback() {
    const stopped = performance.now();
    for (const source of scheduled) { try { source.stop(); } catch {} }
    scheduled = []; nextTime = 0; doneFromServer = false;
    return stopped;
  }
  function barge(source) {
    if (turnId === null || bargeSent) return;
    const started = performance.now();
    stopPlayback();
    bargeSent = true;
    socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({type:'barge_in'}));
    const ms = Math.round(performance.now() - started);
    stats.barge.push(ms); updateStats();
    const entry = agentEntries.get(turnId); if (entry) entry.strong.textContent += ' · INTERRUPTED';
    line('Agent interrupted', `${source} · local playback stopped in ${ms} ms`);
    status('Listening to you…');
  }
  function checkDone(id) {
    if (!doneFromServer || id !== turnId || scheduled.length) return;
    if (!bargeSent && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'playback_done',turn_id:id}));
    turnId = null; doneFromServer = false;
  }
  function playChunk(base64, id) {
    if (id !== turnId || bargeSent) return;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const samples = Math.floor(bytes.length / 2);
    if (!samples) return;
    const data = new DataView(bytes.buffer);
    const buffer = context.createBuffer(1, samples, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) channel[i] = data.getInt16(i*2, true) / 32768;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    const at = Math.max(context.currentTime + .025, nextTime); nextTime = at + buffer.duration;
    scheduled.push(source);
    source.onended = () => { scheduled = scheduled.filter(x => x !== source); checkDone(id); };
    source.start(at);
  }
  function onFrame(event) {
    if (event.data.type !== 'pcm') return;
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) socket.send(event.data.frame);
    const peak = event.data.peak;
    // Fast local trigger: two voiced 32 ms frames. Echo cancellation happens at capture.
    if (peak > .035) { speechFrames++; quietFrames = 0; }
    else { quietFrames++; if (quietFrames >= 3) speechFrames = 0; }
    if (speechFrames >= 2 && !talking) {
      talking = true; if (turnId !== null) barge('local energy VAD');
    }
    if (talking && quietFrames >= 11) {
      talking = false; speechFrames = 0;
      socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({type:'speech_end'}));
    }
  }
  function onMessage(event) {
    const m = JSON.parse(event.data);
    if (m.type === 'connected') status('Connected. Speak naturally; interrupt the agent any time.');
    else if (m.type === 'speech_start') {
      if (turnId !== null) barge('Prisma speech_start');
      line('Caller started speaking', m.utterance_id || '');
    } else if (m.type === 'processing') line('Prisma processing speech');
    else if (m.type === 'transcript') {
      const v = m.metrics?.end_to_final_ms;
      if (v != null) stats.final.push(v); updateStats();
      line('Caller · ' + m.text, `final STT ${v ?? '—'} ms · Prisma ${m.latency ?? '—'} ms · ${m.segment_id || ''}`);
    } else if (m.type === 'turn') {
      const e = m.event || {};
      line('Layer · ' + (e.decision || 'decision').replaceAll('_',' '), m.prompt || '');
      if (m.handoff_brief) { $('liveBrief').textContent = m.handoff_brief; $('liveBrief').classList.add('show'); }
      if (m.session?.state === 'WRITTEN') status('Confirmed promise written.');
    } else if (m.type === 'agent_start') {
      stopPlayback(); turnId = m.turn_id; bargeSent = false;
      agentEntries.set(m.turn_id, line('Agent · ' + m.text, `Turn ${m.turn_id}`));
      status('Agent speaking. You can interrupt.');
    } else if (m.type === 'agent_audio') playChunk(m.audio, m.turn_id);
    else if (m.type === 'agent_done') { if (m.turn_id === turnId) { doneFromServer = true; checkDone(m.turn_id); } }
    else if (m.type === 'tts_first_byte') {
      if (m.end_to_audio_ms != null) stats.audio.push(m.end_to_audio_ms); updateStats();
      line('First TTS audio byte', `${m.end_to_audio_ms ?? '—'} ms from speech end`);
    } else if (m.type === 'interrupted') {
      const entry = agentEntries.get(m.turn_id); if (entry && !entry.strong.textContent.includes('INTERRUPTED')) entry.strong.textContent += ' · INTERRUPTED';
      stopPlayback(); turnId = null;
      if (m.reaction_ms != null) { stats.barge.push(m.reaction_ms); updateStats(); }
      line('Server cancelled TTS', `${m.source} · ${m.reaction_ms ?? '—'} ms from Prisma speech_start`);
    } else if (m.type === 'handoff') {
      stopPlayback(); turnId = null;
      $('liveBrief').textContent = m.brief || 'Human handoff requested'; $('liveBrief').classList.add('show'); status('Human handoff.');
    } else if (m.type === 'error') { line('Streaming error', m.message); status(m.message); }
  }
  async function start() {
    try {
      status('Connecting…');
      context = new AudioContext(); await context.resume();
      const session = await api('/api/session',{method:'POST'});
      stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      await context.audioWorklet.addModule('/static/live-worklet.js');
      mic = new AudioWorkletNode(context,'live-mic'); mic.port.onmessage = onFrame;
      input = context.createMediaStreamSource(stream); input.connect(mic);
      sink = context.createGain(); sink.gain.value = 0; mic.connect(sink); sink.connect(context.destination);
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live/${session.session.id}`);
      socket.onmessage = onMessage;
      socket.onclose = () => { if(active) { status('Connection closed.'); stop(); } };
      socket.onerror = () => status('WebSocket failed.');
      active = true; $('liveStart').textContent = 'End live call';
      line('Live call started', '16 kHz mono PCM · echo cancellation on');
    } catch (error) { status('Could not start: ' + error.message); stop(); }
  }
  function stop() {
    active = false; stopPlayback(); turnId = null;
    if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({type:'stop'})); socket.close(); }
    stream?.getTracks().forEach(t => t.stop()); input?.disconnect(); mic?.disconnect(); sink?.disconnect(); context?.close();
    $('liveStart').textContent = 'Start live call';
  }
  $('liveStart').onclick = () => active ? stop() : start();
  $('mode').onchange = () => {
    const live = $('mode').value === 'live';
    $('livePanel').hidden = !live; $('turnPanel').hidden = live;
    if (!live && active) stop();
  };
})();
