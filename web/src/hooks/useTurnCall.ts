import { useCallback, useEffect, useRef, useState } from 'react';

export type Pipeline = 'naive' | 'layer';

export interface Slots {
  amount_inr?: number | string | null;
  amount_note?: string;
  pay_date?: string | null;
  date_note?: string;
  mode?: string | null;
  mode_note?: string;
  [key: string]: unknown;
}

export interface TurnEvent {
  session_id: string;
  state: string;
  mode: Pipeline;
  transcript: string;
  latency_ms: number;
  decision?: string;
  slots?: Slots;
  verdict?: { slots?: Slots; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TurnSession {
  id: string;
  state: string;
  slots: Slots;
  pending?: string[];
  turns: TurnEvent[];
  [key: string]: unknown;
}

export interface TurnResponse {
  session: TurnSession;
  transcript?: string;
  prompt?: string;
  event?: TurnEvent;
  verdict?: { slots?: Slots; [key: string]: unknown };
  handoff_brief?: string;
  commit?: { written?: boolean; duplicate?: boolean; [key: string]: unknown };
}

export interface LedgerRow {
  session_id: string;
  amount_inr: number;
  pay_date: string;
  mode: string;
  commit_key: string;
}

export interface EvalResponse {
  n: number;
  naive_correct: number;
  layer_correct: number;
  naive_slot_accuracy: number;
  layer_slot_accuracy: number;
  policy?: string;
  details?: unknown[];
}

type ComparisonResults = Partial<Record<Pipeline, TurnResponse>>;

const TERMINAL_STATES = new Set(['WRITTEN', 'HANDOFF', 'REFUSED']);

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  const data: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const body = data as { detail?: unknown };
    const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : data;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data as T;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function useTurnCall(active = true) {
  const [results, setResults] = useState<ComparisonResults>({});
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [status, setStatus] = useState('Start a comparison to begin.');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [evalResult, setEvalResult] = useState<EvalResponse | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [playbackState, setPlaybackState] = useState<'idle' | 'playing' | 'paused' | 'ended'>('idle');
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);

  const idsRef = useRef<Partial<Record<Pipeline, string>>>({});
  const resultsRef = useRef<ComparisonResults>({});
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const partsRef = useRef<BlobPart[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      recorderRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    partsRef.current = [];
    if (mountedRef.current) setRecording(false);
  }, []);

  const setComparisonResults = useCallback((next: ComparisonResults | ((prev: ComparisonResults) => ComparisonResults)) => {
    if (!mountedRef.current) return;
    setResults((prev) => {
      if (!mountedRef.current) return resultsRef.current;
      const value = typeof next === 'function' ? next(prev) : next;
      resultsRef.current = value;
      return value;
    });
  }, []);

  const refreshLedger = useCallback(async () => {
    if (!mountedRef.current) return;
    const ids = Object.values(idsRef.current).filter((id): id is string => Boolean(id));
    if (!ids.length) {
      setLedger([]);
      return;
    }
    try {
      const data = await requestJson<{ rows: LedgerRow[] }>('/api/ledger');
      if (!mountedRef.current) return;
      setLedger(data.rows.filter((row) => ids.includes(row.session_id)));
    } catch (error) {
      if (mountedRef.current) setStatus(error instanceof Error ? error.message : 'Could not load the promise ledger.');
    }
  }, []);

  const speak = useCallback(async (text?: string) => {
    if (!text || !mountedRef.current || !activeRef.current) return;
    try {
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
      if (!response.ok) throw new Error('Timbre unavailable');
      const blob = await response.blob();
      if (!mountedRef.current || !activeRef.current) return;
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onloadedmetadata = () => {
        if (mountedRef.current) setPlaybackDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      };
      audio.ontimeupdate = () => {
        if (mountedRef.current) setPlaybackTime(audio.currentTime);
      };
      audio.onplay = () => {
        if (mountedRef.current) setPlaybackState('playing');
      };
      audio.onpause = () => {
        if (mountedRef.current && audio.currentTime < audio.duration) setPlaybackState('paused');
      };
      audio.onended = () => {
        if (!mountedRef.current) return;
        setPlaybackState('ended');
        setPlaybackTime(audio.duration || 0);
      };
      await audio.play();
      if (!mountedRef.current || !activeRef.current) audio.pause();
    } catch {
      if (mountedRef.current) {
        setPlaybackState('idle');
        setStatus('Voice unavailable; read back is shown as text.');
      }
    }
  }, []);

  const toggleReadback = useCallback(async (text?: string) => {
    if (!mountedRef.current || !activeRef.current) return;
    const audio = audioRef.current;
    if (!audio || !objectUrlRef.current) {
      await speak(text);
      return;
    }
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (audio.ended) audio.currentTime = 0;
    try {
      await audio.play();
      if (!mountedRef.current || !activeRef.current) audio.pause();
    } catch {
      if (mountedRef.current) {
        setPlaybackState('idle');
        setStatus('Voice unavailable; read back is shown as text.');
      }
    }
  }, [speak]);

  const seekReadback = useCallback((time: number) => {
    if (!mountedRef.current || !activeRef.current) return;
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(time)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, time));
    setPlaybackTime(audio.currentTime);
  }, []);

  const applyResponse = useCallback((pipeline: Pipeline, response: TurnResponse) => {
    if (!mountedRef.current) return;
    setComparisonResults((previous) => ({ ...previous, [pipeline]: response }));
  }, [setComparisonResults]);

  const startComparison = useCallback(async () => {
    if (!mountedRef.current || !activeRef.current) return;
    setBusy(true);
    setStatus('Starting paired sessions…');
    setComparisonResults({});
    setLedger([]);
    setEvalResult(null);
    try {
      const [naive, layer] = await Promise.all([
        requestJson<TurnResponse>('/api/session', { method: 'POST' }),
        requestJson<TurnResponse>('/api/session', { method: 'POST' }),
      ]);
      if (!mountedRef.current) return;
      idsRef.current = { naive: naive.session.id, layer: layer.session.id };
      setComparisonResults({ naive, layer });
      setStatus('Both pipelines are ready. Send a borrower turn.');
      void refreshLedger();
      void speak(layer.prompt);
    } catch (error) {
      if (mountedRef.current) setStatus(`Could not start the comparison: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refreshLedger, setComparisonResults, speak]);

  const processTurn = useCallback(async (submit: (pipeline: Pipeline, sessionId: string) => Promise<TurnResponse>, modeLabel: string) => {
    const ids = idsRef.current;
    if (!ids.layer || !mountedRef.current) return;
    const active = (['naive', 'layer'] as Pipeline[]).filter((pipeline) => {
      const id = ids[pipeline];
      const state = resultsRef.current[pipeline]?.session.state;
      return Boolean(id) && !TERMINAL_STATES.has(state || '');
    });
    if (!active.length) return;

    setBusy(true);
    setStatus(modeLabel);
    try {
      const responses = await Promise.all(active.map(async (pipeline) => {
        const response = await submit(pipeline, ids[pipeline]!);
        applyResponse(pipeline, response);
        return { pipeline, response };
      }));
      if (!mountedRef.current) return;
      setStatus(modeLabel.startsWith('Transcribing') ? 'Audio turn processed.' : 'Turn processed.');
      await refreshLedger();
      const layerResult = responses.find(({ pipeline }) => pipeline === 'layer')?.response;
      if (layerResult?.prompt) await speak(layerResult.prompt);
    } catch (error) {
      if (mountedRef.current) setStatus(`Turn failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [applyResponse, refreshLedger, speak]);

  const submitText = useCallback(async (transcript: string) => {
    if (!transcript.trim() || !idsRef.current.layer || !mountedRef.current || !activeRef.current) return;
    await processTurn(async (pipeline, sessionId) => requestJson<TurnResponse>('/api/turn-text', jsonInit({
      session_id: sessionId,
      transcript,
      mode: pipeline,
    })), 'Processing both pipelines…');
  }, [processTurn]);

  const submitAudio = useCallback(async (audio: Blob) => {
    if (!idsRef.current.layer || !mountedRef.current || !activeRef.current) return;
    await processTurn(async (pipeline, sessionId) => {
      const form = new FormData();
      form.append('session_id', sessionId);
      form.append('mode', pipeline);
      form.append('audio', audio, 'turn.webm');
      return requestJson<TurnResponse>('/api/turn', { method: 'POST', body: form });
    }, 'Transcribing the same clip in both pipelines…');
  }, [processTurn]);

  const toggleRecording = useCallback(async () => {
    if (recording) {
      recorderRef.current?.stop();
      if (mountedRef.current) setRecording(false);
      return;
    }
    if (!idsRef.current.layer || !mountedRef.current || !activeRef.current) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('This browser does not support microphone recording.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || !activeRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      partsRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) partsRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const blob = new Blob(partsRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size) void submitAudio(blob);
      };
      recorder.start();
      setRecording(true);
      setStatus('Recording… select Stop recording when the turn is complete.');
    } catch (error) {
      if (mountedRef.current && activeRef.current) {
        setStatus(`Microphone unavailable: ${error instanceof Error ? error.message : 'Check browser permission.'}`);
        setRecording(false);
      }
    }
  }, [recording, submitAudio]);

  const confirm = useCallback(async (accepted: boolean) => {
    const sessionId = idsRef.current.layer;
    if (!sessionId || !mountedRef.current || !activeRef.current) return;
    setBusy(true);
    setStatus(accepted ? 'Confirming the read back…' : 'Requesting a correction…');
    try {
      const response = await requestJson<TurnResponse>('/api/confirm', jsonInit({ session_id: sessionId, accepted }));
      if (!mountedRef.current) return;
      applyResponse('layer', response);
      await refreshLedger();
      setStatus(accepted ? 'Promise confirmed and written to the ledger.' : 'Correction requested. Say the corrected amount, date, and payment method.');
      if (response.prompt) await speak(response.prompt);
    } catch (error) {
      if (mountedRef.current) setStatus(`Could not submit confirmation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [applyResponse, refreshLedger, speak]);

  const runEval = useCallback(async () => {
    if (!mountedRef.current || !activeRef.current) return;
    setEvalBusy(true);
    setStatus('Running the supplied text fixtures…');
    try {
      const result = await requestJson<EvalResponse>('/api/eval');
      if (!mountedRef.current) return;
      setEvalResult(result);
      setStatus('Fixture evaluation complete.');
    } catch (error) {
      if (mountedRef.current) setStatus(`Evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (mountedRef.current) setEvalBusy(false);
    }
  }, []);

  const canTurn = active && Boolean(idsRef.current.layer) && !TERMINAL_STATES.has(results.layer?.session.state || '');
  const canConfirm = results.layer?.session.state === 'CONFIRMING';
  const prompt = results.layer?.prompt || '';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRecording();
      if (audioRef.current) {
        audioRef.current.onloadedmetadata = null;
        audioRef.current.ontimeupdate = null;
        audioRef.current.onplay = null;
        audioRef.current.onpause = null;
        audioRef.current.onended = null;
      }
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [cancelRecording]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      cancelRecording();
      audioRef.current?.pause();
    }
  }, [active, cancelRecording]);

  return {
    results,
    ledger,
    status,
    busy,
    recording,
    evalBusy,
    evalResult,
    playbackState,
    playbackTime,
    playbackDuration,
    prompt,
    canTurn,
    canConfirm,
    startComparison,
    submitText,
    toggleRecording,
    confirm,
    speak,
    toggleReadback,
    seekReadback,
    runEval,
  };
}
