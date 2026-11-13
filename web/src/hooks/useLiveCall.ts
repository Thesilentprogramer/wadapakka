import { useCallback, useEffect, useRef, useState } from 'react';
import type { LedgerRow, PromiseProposal } from './useTurnCall';

export type PipelineKind = 'naive' | 'layer';

export type PipelineResult = {
  transcript?: string;
  prompt?: string;
  handoff_brief?: string;
  proposal?: PromiseProposal | null;
  proposal_id?: string;
  commit_status?: string;
  evidence_id?: string | null;
  audit_status?: string;
  readback_status?: string;
  commit?: { promise_id?: string; status?: string; row?: LedgerRow; promise?: LedgerRow; [key: string]: unknown };
  ledger_row?: LedgerRow;
  verified_commit?: boolean;
  commit_verification_error?: string;
  session?: {
    id?: string;
    state?: string;
    slots?: Record<string, string | number | null | undefined>;
    proposal?: PromiseProposal | null;
    audit_status?: string;
  };
  event?: { decision?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type LiveTimelineEntry = {
  id: number;
  time: string;
  title: string;
  detail: string;
  kind?: string;
};

export type LiveStats = {
  final: number | null;
  audio: number | null;
  barge: number | null;
};

export type LiveCallOptions = {
  onPipelineUpdate?: (kind: PipelineKind, data: PipelineResult) => void;
};

type PipelineResults = Partial<Record<PipelineKind, PipelineResult>>;
type StatKind = keyof LiveStats;
type StatSamples = Record<StatKind, number[]>;
type BargeDecision = { duck: boolean; cancel: boolean; threshold: number; sustained_ms: number };
type BargeVADInstance = {
  reset(): void;
  agentStart(now: number): void;
  agentEnd(): void;
  setPlaybackLevel(level: number): void;
  frame(peak: number, now: number, playing: boolean, headphones?: boolean): BargeDecision;
};
type LiveMessage = Record<string, any> & { type: string };

declare global {
  interface Window {
    BargeVAD?: new () => BargeVADInstance;
  }
}

const emptyStats: LiveStats = { final: null, audio: null, barge: null };
const terminalStates = new Set(['WRITTEN', 'HANDOFF', 'REFUSED']);

function currentProposalId(result?: PipelineResult): string | undefined {
  const proposal = result?.proposal || result?.session?.proposal;
  const id = proposal?.id || proposal?.proposal_id || result?.proposal_id;
  return typeof id === 'string' && id ? id : undefined;
}

function isPositiveCommitStatus(result: PipelineResult) {
  return ['committed', 'written', 'duplicate', 'verified', 'success'].includes(String(result.commit_status || result.commit?.status || '').toLowerCase());
}

function ledgerVerifies(result: PipelineResult, rows: LedgerRow[]) {
  const sessionId = result.session?.id;
  const proposalId = currentProposalId(result);
  const proposal = result.proposal || result.session?.proposal;
  const promiseId = result.commit?.promise_id || result.commit?.row?.promise_id || result.commit?.promise?.promise_id || result.ledger_row?.promise_id;
  const amountInr = proposal?.amount_inr ?? (proposal?.amount_paise === undefined ? undefined : proposal.amount_paise / 100);
  return rows.some((row) => {
    if (promiseId && row.promise_id === promiseId) return true;
    if (proposalId && row.proposal_id === proposalId) return true;
    if (!sessionId || row.session_id !== sessionId || amountInr === undefined) return false;
    return Number(row.amount_inr ?? (row.amount_paise === undefined ? NaN : row.amount_paise / 100)) === Number(amountInr)
      && row.pay_date === proposal?.pay_date
      && String(row.mode || '').toLowerCase() === String(proposal?.mode || '').toLowerCase();
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : JSON.stringify(data?.detail ?? data);
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return data as T;
}

function loadBargeVAD(): Promise<new () => BargeVADInstance> {
  if (window.BargeVAD) return Promise.resolve(window.BargeVAD);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-barge-vad]');
    if (existing) {
      existing.addEventListener('load', () => window.BargeVAD ? resolve(window.BargeVAD) : reject(new Error('Barge VAD did not load.')),
        { once: true });
      existing.addEventListener('error', () => reject(new Error('Could not load Barge VAD.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = '/barge-vad.js';
    script.async = true;
    script.dataset.bargeVad = 'true';
    script.onload = () => window.BargeVAD ? resolve(window.BargeVAD) : reject(new Error('Barge VAD did not load.'));
    script.onerror = () => reject(new Error('Could not load Barge VAD.'));
    document.head.append(script);
  });
}

function average(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export function useLiveCall({ onPipelineUpdate }: LiveCallOptions = {}) {
  const [isRunning, setIsRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [status, setStatus] = useState('Start a live call to enable the microphone.');
  const [callState, setCallState] = useState('Standby');
  const [headphonesMode, setHeadphonesMode] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [results, setResults] = useState<PipelineResults>({});
  const [handoffBrief, setHandoffBrief] = useState('');
  const [stats, setStats] = useState<LiveStats>(emptyStats);
  const [timeline, setTimeline] = useState<LiveTimelineEntry[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const micRef = useRef<AudioWorkletNode | null>(null);
  const inputRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const playbackGainRef = useRef<GainNode | null>(null);
  const scheduledRef = useRef<AudioBufferSourceNode[]>([]);
  const nextTimeRef = useRef(0);
  const turnIdRef = useRef<number | string | null>(null);
  const doneFromServerRef = useRef(false);
  const quietFramesRef = useRef(0);
  const talkingRef = useRef(false);
  const bargeSentRef = useRef(false);
  const vadRef = useRef<BargeVADInstance | null>(null);
  const playbackLevelRef = useRef(0);
  const agentEntriesRef = useRef(new Map<number | string, number>());
  const sessionIdsRef = useRef<{ naive?: string; layer?: string }>({});
  const resultsRef = useRef<PipelineResults>({});
  const statSamplesRef = useRef<StatSamples>({ final: [], audio: [], barge: [] });
  const timelineIdRef = useRef(0);
  const lastMeterUpdateRef = useRef(0);
  const headphonesRef = useRef(headphonesMode);
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const onPipelineUpdateRef = useRef(onPipelineUpdate);
  onPipelineUpdateRef.current = onPipelineUpdate;
  headphonesRef.current = headphonesMode;

  const addTimeline = useCallback((title: string, detail = '', kind?: string) => {
    const id = ++timelineIdRef.current;
    setTimeline(current => [{ id, time: new Date().toLocaleTimeString(), title, detail, kind }, ...current]);
    return id;
  }, []);

  const updatePipeline = useCallback((kind: PipelineKind, data: PipelineResult) => {
    const next = { ...resultsRef.current, [kind]: data };
    resultsRef.current = next;
    setResults(next);
    onPipelineUpdateRef.current?.(kind, data);
  }, []);

  const verifyGuardedCommit = useCallback(async (result: PipelineResult) => {
    if (!isPositiveCommitStatus(result) || !result.session?.id) return;
    const sessionId = result.session.id;
    const proposalId = currentProposalId(result);
    try {
      const data = await api<{ rows?: LedgerRow[] }>('/api/ledger');
      const verified = ledgerVerifies(result, Array.isArray(data.rows) ? data.rows : []);
      const latest = resultsRef.current.layer;
      if (!latest || latest.session?.id !== sessionId || (proposalId && currentProposalId(latest) !== proposalId)) return;
      updatePipeline('layer', { ...latest, verified_commit: verified, commit_verification_error: undefined });
      if (verified) {
        const status = String(latest.commit_status || latest.commit?.status || '').toLowerCase();
        setStatus(status === 'duplicate' ? 'An existing guarded Ledger row was verified.' : 'Confirmed promise verified in the guarded Ledger.');
        setCallState('Confirmed');
      } else {
        addTimeline('Commit not verified', 'The session reports a commit status, but no matching guarded Ledger row was returned.', 'error');
      }
    } catch (error) {
      const latest = resultsRef.current.layer;
      if (latest?.session?.id !== sessionId || (proposalId && currentProposalId(latest) !== proposalId)) return;
      updatePipeline('layer', {
        ...latest,
        verified_commit: false,
        commit_verification_error: error instanceof Error ? error.message : String(error),
      });
      addTimeline('Ledger verification unavailable', error instanceof Error ? error.message : String(error), 'error');
    }
  }, [addTimeline, updatePipeline]);

  const pushStat = useCallback((kind: StatKind, value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    statSamplesRef.current[kind].push(value);
    setStats({
      final: average(statSamplesRef.current.final),
      audio: average(statSamplesRef.current.audio),
      barge: average(statSamplesRef.current.barge),
    });
  }, []);

  const markAgentInterrupted = useCallback((turnId: number | string) => {
    const timelineId = agentEntriesRef.current.get(turnId);
    if (timelineId === undefined) return;
    setTimeline(current => current.map(entry => entry.id === timelineId && !entry.title.includes('INTERRUPTED')
      ? { ...entry, title: `${entry.title} · INTERRUPTED` }
      : entry));
  }, []);

  const stopPlayback = useCallback(() => {
    const stopped = performance.now();
    for (const source of scheduledRef.current) {
      try { source.stop(); } catch { /* Source already ended. */ }
    }
    scheduledRef.current = [];
    nextTimeRef.current = 0;
    doneFromServerRef.current = false;
    vadRef.current?.agentEnd();
    const context = contextRef.current;
    const gain = playbackGainRef.current;
    if (context && gain) gain.gain.setTargetAtTime(1, context.currentTime, 0.02);
    return stopped;
  }, []);

  const checkDone = useCallback((id: number | string) => {
    if (!doneFromServerRef.current || id !== turnIdRef.current || scheduledRef.current.length) return;
    const socket = socketRef.current;
    if (!bargeSentRef.current && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'playback_done', turn_id: id, proposal_id: currentProposalId(resultsRef.current.layer) }));
    }
    turnIdRef.current = null;
    doneFromServerRef.current = false;
    vadRef.current?.agentEnd();
    const context = contextRef.current;
    const gain = playbackGainRef.current;
    if (context && gain) gain.gain.setTargetAtTime(1, context.currentTime, 0.02);

    const layerResult = resultsRef.current.layer;
    const sessionState = layerResult?.session?.state;
    if (sessionState === 'WRITTEN' && layerResult?.verified_commit === true) {
      const commitStatus = String(layerResult.commit_status || layerResult.commit?.status || '').toLowerCase();
      setStatus(commitStatus === 'duplicate' ? 'An existing guarded Ledger row was verified.' : 'Confirmed promise verified in the guarded Ledger.');
      setCallState('Confirmed');
    } else if (sessionState === 'WRITTEN') {
      setStatus('Session reports a commit, but the matching Ledger row is not verified yet.');
      setCallState('Verifying commit');
    } else if (sessionState === 'HANDOFF') {
      setStatus('Human handoff.');
      setCallState('Handoff');
    } else if (sessionState === 'REFUSED') {
      setStatus('Borrower refused.');
      setCallState('Refused');
    } else {
      setStatus('Connected. Speak naturally; interrupt the agent any time.');
      setCallState('Listening');
    }
  }, []);

  const barge = useCallback((source: string, sustainedMs = 0) => {
    const turnId = turnIdRef.current;
    if (turnId === null || bargeSentRef.current) return;
    const started = performance.now();
    stopPlayback();
    bargeSentRef.current = true;
    const socket = socketRef.current;
    if (source === 'local_sustained' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'barge_in', source, sustained_ms: sustainedMs, proposal_id: currentProposalId(resultsRef.current.layer) }));
    }
    const reaction = Math.round(performance.now() - started);
    markAgentInterrupted(turnId);
    addTimeline('Agent interrupted', `${source} · browser playback stopped in ${reaction} ms`);
    setStatus('Listening to you…');
    setCallState('Listening');
  }, [addTimeline, markAgentInterrupted, stopPlayback]);

  const playChunk = useCallback((base64: string, id: number | string) => {
    const context = contextRef.current;
    const gain = playbackGainRef.current;
    if (!context || !gain || id !== turnIdRef.current || bargeSentRef.current) return;
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const samples = Math.floor(bytes.length / 2);
    if (!samples) return;
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = context.createBuffer(1, samples, 16000);
    const channel = buffer.getChannelData(0);
    let sum = 0;
    for (let index = 0; index < samples; index++) {
      channel[index] = data.getInt16(index * 2, true) / 32768;
      sum += channel[index] * channel[index];
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    playbackLevelRef.current = Math.sqrt(sum / samples);
    vadRef.current?.setPlaybackLevel(playbackLevelRef.current);
    const at = Math.max(context.currentTime + 0.025, nextTimeRef.current);
    nextTimeRef.current = at + buffer.duration;
    scheduledRef.current.push(source);
    source.onended = () => {
      scheduledRef.current = scheduledRef.current.filter(item => item !== source);
      checkDone(id);
    };
    source.start(at);
  }, [checkDone]);

  const updateMicFrame = useCallback((event: MessageEvent) => {
    if (event.data?.type !== 'pcm') return;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 256000) socket.send(event.data.frame as ArrayBuffer);

    const peak = Number(event.data.peak) || 0;
    const now = performance.now();
    const decision = vadRef.current?.frame(peak, now, turnIdRef.current !== null, headphonesRef.current);
    if (!decision) return;

    const level = Math.min(100, Math.round(peak * 300));
    if (now - lastMeterUpdateRef.current >= 60) {
      lastMeterUpdateRef.current = now;
      setMicLevel(level);
    }
    const context = contextRef.current;
    const gain = playbackGainRef.current;
    if (context && gain && turnIdRef.current !== null) {
      if (decision.duck) gain.gain.setTargetAtTime(0.3, context.currentTime, 0.02);
      else gain.gain.setTargetAtTime(1, context.currentTime, 0.04);
    }
    if (decision.cancel && turnIdRef.current !== null) barge('local_sustained', decision.sustained_ms);

    if (peak > decision.threshold) {
      talkingRef.current = true;
      quietFramesRef.current = 0;
    } else quietFramesRef.current++;
    if (talkingRef.current && quietFramesRef.current >= 11) {
      talkingRef.current = false;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'speech_end' }));
    }
  }, [barge]);

  const handleMessage = useCallback((event: MessageEvent) => {
    let message: LiveMessage;
    try { message = JSON.parse(String(event.data)) as LiveMessage; }
    catch { addTimeline('Invalid streaming message', '', 'error'); return; }

    if (message.type === 'connected') {
      setStatus('Connected. Speak naturally; interrupt the agent any time.');
      setCallState('Listening');
    } else if (message.type === 'speech_start') {
      if (turnIdRef.current !== null) barge('prisma_speech_start');
      addTimeline('Caller started speaking', message.utterance_id || '');
    } else if (message.type === 'processing') {
      addTimeline('Prisma processing speech');
    } else if (message.type === 'transcript') {
      const latency = message.metrics?.end_to_final_ms;
      if (latency != null) pushStat('final', latency);
      addTimeline(
        `${message.ignored ? 'Ignored STT · ' : 'Caller · '}${message.text || ''}`,
        `final STT ${latency ?? '—'} ms · Prisma ${message.latency ?? '—'} ms · ${message.segment_id || ''}`,
        message.ignored ? 'ignored' : 'transcript',
      );
    } else if (message.type === 'turn') {
      const current = message as PipelineResult;
      const eventData = current.event || {};
      const decision = typeof eventData.decision === 'string' ? eventData.decision.replaceAll('_', ' ') : 'decision';
      addTimeline(`Layer · ${decision}`, current.prompt || '', 'turn');
      updatePipeline('layer', current);
      if (current.handoff_brief) setHandoffBrief(current.handoff_brief);

      const state = current.session?.state;
      if (state === 'WRITTEN' || isPositiveCommitStatus(current)) void verifyGuardedCommit(current);

      const transcript = current.transcript;
      const naiveId = sessionIdsRef.current.naive;
      const naiveResult = resultsRef.current.naive;
      if (transcript && naiveId && !terminalStates.has(naiveResult?.session?.state || '')) {
        void api<PipelineResult>('/api/turn-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: naiveId, transcript, mode: 'naive' }),
        }).then(data => updatePipeline('naive', data))
          .catch(error => addTimeline('Comparison error', error instanceof Error ? error.message : String(error), 'error'));
      }
    } else if (message.type === 'agent_start') {
      stopPlayback();
      turnIdRef.current = message.turn_id;
      bargeSentRef.current = false;
      vadRef.current?.agentStart(performance.now());
      const timelineId = addTimeline(`Agent · ${message.text || ''}`, `Turn ${message.turn_id}`);
      agentEntriesRef.current.set(message.turn_id, timelineId);
      setStatus('Agent speaking. You can interrupt.');
      setCallState('Agent speaking');
    } else if (message.type === 'agent_audio') {
      playChunk(message.audio, message.turn_id);
    } else if (message.type === 'agent_done') {
      if (message.turn_id === turnIdRef.current) {
        doneFromServerRef.current = true;
        checkDone(message.turn_id);
      }
    } else if (message.type === 'playback_ack') {
      const current = resultsRef.current.layer;
      const expectedProposalId = currentProposalId(current);
      if (current && (!message.proposal_id || message.proposal_id === expectedProposalId)) {
        const proposal = current.proposal || current.session?.proposal;
        const completedProposal = proposal ? { ...proposal, readback_status: 'complete' } : proposal;
        updatePipeline('layer', {
          ...current,
          readback_status: 'complete',
          proposal: completedProposal,
          session: { ...current.session, state: 'AWAITING_CONFIRMATION', proposal: completedProposal },
        });
        addTimeline('Read back completed', 'Server acknowledged playback for the active proposal. Spoken confirmation can now be checked.', 'turn');
      }
    } else if (message.type === 'tts_first_byte') {
      if (message.end_to_audio_ms != null) pushStat('audio', message.end_to_audio_ms);
      addTimeline('First TTS audio byte', `${message.end_to_audio_ms ?? '—'} ms from speech end`);
    } else if (message.type === 'interrupted') {
      markAgentInterrupted(message.turn_id);
      stopPlayback();
      turnIdRef.current = null;
      if (message.reaction_ms != null) pushStat('barge', message.reaction_ms);
      const origin = message.source === 'prisma_speech_start' ? 'Prisma speech_start' : 'local sustained detection';
      addTimeline('Server cancelled TTS', `${message.source} · ${message.reaction_ms != null ? `${message.reaction_ms} ms from ${origin}` : 'reaction unavailable'}`, 'interrupted');
      if (message.session) {
        const current = resultsRef.current.layer;
        if (current) updatePipeline('layer', {
          ...current,
          session: message.session,
          proposal: message.session.proposal || current.proposal,
          readback_status: message.session.proposal?.readback_status || 'interrupted',
        });
      }
      setCallState('Listening');
    } else if (message.type === 'handoff') {
      stopPlayback();
      turnIdRef.current = null;
      const brief = message.brief || 'Human handoff requested';
      setHandoffBrief(brief);
      setStatus('Human handoff.');
      setCallState('Handoff');
      addTimeline('Human handoff', brief, 'interrupted');
    } else if (message.type === 'error') {
      addTimeline('Streaming error', message.message || 'Unknown streaming error', 'error');
      setStatus(message.message || 'Streaming error');
      setCallState('Connection issue');
    }
  }, [addTimeline, barge, checkDone, markAgentInterrupted, playChunk, pushStat, stopPlayback, updatePipeline, verifyGuardedCommit]);

  const closeCall = useCallback((updateUI = true) => {
    generationRef.current++;
    activeRef.current = false;
    startingRef.current = false;
    turnIdRef.current = null;
    stopPlayback();

    const socket = socketRef.current;
    socketRef.current = null;
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'stop' })); } catch { /* Socket may be closing. */ }
    }
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();

    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    for (const node of [inputRef.current, micRef.current, sinkRef.current]) {
      try { node?.disconnect(); } catch { /* Node may already be disconnected. */ }
    }
    inputRef.current = null;
    micRef.current = null;
    sinkRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    playbackGainRef.current = null;
    if (context && context.state !== 'closed') void context.close();
    vadRef.current = null;

    if (updateUI) {
      setMicLevel(0);
      setIsRunning(false);
      setIsStarting(false);
      setCallState('Standby');
    }
  }, [stopPlayback]);

  const startCall = useCallback(async () => {
    if (activeRef.current || startingRef.current) return;
    startingRef.current = true;
    const generation = ++generationRef.current;
    setIsStarting(true);
    setStatus('Connecting…');
    setCallState('Connecting');
    setHandoffBrief('');
    setTimeline([]);
    statSamplesRef.current = { final: [], audio: [], barge: [] };
    setStats(emptyStats);
    resultsRef.current = {};
    setResults({});
    sessionIdsRef.current = {};
    agentEntriesRef.current.clear();

    try {
      // Start/resume the context in the click's user-activation task before
      // waiting on the small public VAD script to load.
      const context = new AudioContext();
      contextRef.current = context;
      const resumeContext = context.resume();
      const vadConstructorPromise = loadBargeVAD();
      const [vadConstructor] = await Promise.all([vadConstructorPromise, resumeContext]);
      if (generation !== generationRef.current) return;
      vadRef.current = new vadConstructor();
      vadRef.current.reset();
      const playbackGain = context.createGain();
      playbackGain.connect(context.destination);
      playbackGainRef.current = playbackGain;

      const [layerSession, naiveSession] = await Promise.all([
        api<PipelineResult>('/api/session', { method: 'POST' }),
        api<PipelineResult>('/api/session', { method: 'POST' }),
      ]);
      if (generation !== generationRef.current) return;
      const ids = { layer: layerSession.session?.id, naive: naiveSession.session?.id };
      sessionIdsRef.current = ids;
      updatePipeline('layer', layerSession);
      updatePipeline('naive', naiveSession);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (generation !== generationRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      await context.audioWorklet.addModule('/live-worklet.js');
      if (generation !== generationRef.current) return;
      const mic = new AudioWorkletNode(context, 'live-mic');
      mic.port.onmessage = updateMicFrame;
      const input = context.createMediaStreamSource(stream);
      input.connect(mic);
      const sink = context.createGain();
      sink.gain.value = 0;
      mic.connect(sink);
      sink.connect(context.destination);
      micRef.current = mic;
      inputRef.current = input;
      sinkRef.current = sink;

      if (!ids.layer) throw new Error('Layer session was not created.');
      const socketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${socketProtocol}//${location.host}/api/live/${ids.layer}`);
      socketRef.current = socket;
      socket.onmessage = handleMessage;
      socket.onclose = () => {
        if (activeRef.current) {
          closeCall();
          setStatus('Connection closed.');
        }
      };
      socket.onerror = () => setStatus('WebSocket failed.');
      activeRef.current = true;
      setIsRunning(true);
      setCallState('Connecting');
      addTimeline('Live call started', '16 kHz mono PCM · echo cancellation on');
    } catch (error) {
      if (generation !== generationRef.current) return;
      closeCall();
      setStatus(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (generation === generationRef.current) {
        startingRef.current = false;
        setIsStarting(false);
      }
    }
  }, [addTimeline, closeCall, handleMessage, updateMicFrame, updatePipeline]);

  const endCall = useCallback(() => {
    closeCall();
    setStatus('Live call ended.');
  }, [closeCall]);

  useEffect(() => () => closeCall(false), [closeCall]);

  return {
    isRunning,
    isStarting,
    status,
    callState,
    headphonesMode,
    setHeadphonesMode,
    micLevel,
    results,
    handoffBrief,
    stats,
    timeline,
    startCall,
    endCall,
  };
}
