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
  proposal?: PromiseProposal | null;
  audit?: AuditRecord | null;
  audit_status?: string;
  [key: string]: unknown;
}

export interface PromiseProposal {
  id?: string;
  proposal_id?: string;
  version?: number;
  amount_inr?: number;
  amount_paise?: number;
  pay_date?: string;
  mode?: string;
  readback_text?: string;
  readback_status?: string;
  status?: string;
  [key: string]: unknown;
}

export interface AuditRecord {
  audit_id?: string;
  session_id?: string;
  status?: string;
  audit_status?: string;
  discrepancy?: string | Record<string, unknown>;
  field_diffs?: Array<Record<string, unknown>> | Record<string, unknown>;
  reasons?: string[];
  transcript_snippets?: string[] | Record<string, unknown>;
  parsed_candidates?: Record<string, unknown> | unknown[];
  proposal_snapshot?: PromiseProposal | null;
  ledger_snapshot?: LedgerRow | null;
  source_turn_ids?: Array<string | number>;
  [key: string]: unknown;
}

export interface TurnResponse {
  session: TurnSession;
  transcript?: string;
  prompt?: string;
  event?: TurnEvent;
  verdict?: { slots?: Slots; [key: string]: unknown };
  handoff_brief?: string;
  proposal?: PromiseProposal | null;
  proposal_id?: string;
  commit_status?: string;
  evidence_id?: string | null;
  readback_status?: string;
  audit_status?: string;
  audit?: AuditRecord | null;
  commit?: { written?: boolean; duplicate?: boolean; status?: string; row?: LedgerRow; promise?: LedgerRow; promise_id?: string; [key: string]: unknown };
  ledger_row?: LedgerRow;
  verified_commit?: boolean;
}

export interface LedgerRow {
  promise_id?: string;
  account_id?: string;
  session_id?: string;
  proposal_id?: string;
  amount_inr?: number;
  amount_paise?: number;
  pay_date?: string;
  mode?: string;
  status?: string;
  review_status?: string;
  confirmation_source?: string;
  source?: string;
  confirmation_evidence_id?: string;
  evidence_id?: string;
  confirmed_at?: string;
  created_at?: string;
  commit_key?: string;
  [key: string]: unknown;
}

export interface UnconfirmedProposal {
  session_id: string;
  account_id?: string;
  proposal?: PromiseProposal | null;
  audit_status?: string;
  [key: string]: unknown;
}

export interface EvalResponse {
  n: number;
  naive_correct: number;
  layer_correct: number;
  naive_slot_accuracy: number;
  layer_slot_accuracy: number;
  policy?: string;
  details?: Array<{ id: string; note: string; naive_correct: boolean; layer_correct: boolean }>;
}

export interface AdversarialCheck {
  passed?: boolean;
  pass?: boolean;
  ok?: boolean;
  numerator?: number;
  denominator?: number;
  passed_count?: number;
  total?: number;
  detail?: string;
  [key: string]: unknown;
}

export interface AdversarialCase {
  id?: string;
  case_id?: string;
  persona?: string;
  name?: string;
  expected_state?: string;
  observed_state?: string;
  final_state?: string;
  expected?: string | Record<string, unknown>;
  observed?: string | Record<string, unknown>;
  checks?: Record<string, boolean | AdversarialCheck>;
  observed_transitions?: Array<string | Record<string, unknown>>;
  transitions?: Array<string | Record<string, unknown>>;
  row_count?: number;
  errors?: string[];
  failing_turn?: string | number;
  failed_turn?: string | number;
  turns?: Array<Record<string, unknown>>;
  session_id?: string;
  audit_id?: string;
  [key: string]: unknown;
}

export interface AdversarialEvalResponse {
  passed?: boolean | number;
  cases?: AdversarialCase[];
  personas?: AdversarialCase[];
  results?: AdversarialCase[];
  negative_variants?: Array<Record<string, unknown> | string> | Record<string, unknown>;
  metrics?: Record<string, number | AdversarialCheck>;
  aggregates?: Record<string, number | AdversarialCheck>;
  [key: string]: unknown;
}

export interface HandoffRow {
  id?: string;
  session_id: string;
  reason: string;
  reason_evidence?: string;
  status?: 'open' | 'taken_over' | 'resolved';
  taken_over_by?: string;
  taken_over_at?: string;
  brief: string;
  transcript?: string | Array<{ speaker: string; text: string; timestamp: string }>;
  transcript_snippets?: string[];
  logged_at: string;
  unresolved_slot_candidates?: Record<string, unknown> | unknown[];
  readback_status?: string;
  audit_status?: string;
  discrepancy?: string;
  audit?: AuditRecord;
  [key: string]: unknown;
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

function proposalIdOf(response?: TurnResponse): string | undefined {
  const proposal = response?.proposal || response?.session?.proposal;
  const id = proposal?.id || proposal?.proposal_id || response?.proposal_id;
  return typeof id === 'string' && id.length ? id : undefined;
}

function proposalOf(response?: TurnResponse): PromiseProposal | undefined {
  return response?.proposal || response?.session?.proposal || undefined;
}

function commitStatusOf(response: TurnResponse): string {
  return String(response.commit_status || response.commit?.status || '').toLowerCase();
}

function hasVerifiedLedgerRow(rows: LedgerRow[], response: TurnResponse, sessionId: string, proposalId: string): boolean {
  const promiseId = response.commit?.promise_id
    || response.commit?.row?.promise_id
    || response.commit?.promise?.promise_id
    || response.ledger_row?.promise_id;
  const proposal = response.proposal || response.session?.proposal;
  const amountInr = proposal?.amount_inr ?? (proposal?.amount_paise == null ? undefined : proposal.amount_paise / 100);
  return rows.some((row) => {
    if (promiseId && row.promise_id === promiseId) return true;
    if (row.proposal_id === proposalId) return true;
    if (row.session_id !== sessionId || amountInr === undefined) return false;
    return Number(row.amount_inr ?? (row.amount_paise == null ? NaN : row.amount_paise / 100)) === Number(amountInr)
      && row.pay_date === proposal?.pay_date
      && String(row.mode || '').toLowerCase() === String(proposal?.mode || '').toLowerCase();
  });
}

function auditFromResponse(data: unknown): AuditRecord | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  const candidate = (value.audit && typeof value.audit === 'object' ? value.audit : value) as AuditRecord;
  return candidate.audit_id || candidate.session_id || candidate.status || candidate.audit_status ? candidate : null;
}

function readbackTargetOf(response?: TurnResponse): { sessionId: string; proposalId: string } | null {
  if (!response?.session?.id) return null;
  const proposal = response.proposal || response.session.proposal;
  const id = proposalIdOf(response);
  const decision = String(response.event?.decision || '').toLowerCase();
  const readbackText = typeof proposal?.readback_text === 'string' ? proposal.readback_text : '';
  const isReadback = decision.includes('readback') || decision.includes('read_back') || Boolean(readbackText && readbackText === response.prompt);
  return isReadback && id ? { sessionId: response.session.id, proposalId: id } : null;
}

export function useTurnCall(active = true) {
  const [results, setResults] = useState<ComparisonResults>({});
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [unconfirmedProposals, setUnconfirmedProposals] = useState<UnconfirmedProposal[]>([]);
  const [ledgerError, setLedgerError] = useState('');
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [sessionAudits, setSessionAudits] = useState<Record<string, AuditRecord>>({});
  const [auditError, setAuditError] = useState('');
  const [handoffs, setHandoffs] = useState<HandoffRow[]>([]);
  const [handoffError, setHandoffError] = useState('');
  const [evalError, setEvalError] = useState('');
  const [status, setStatus] = useState('Start a comparison to begin.');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [evalResult, setEvalResult] = useState<EvalResponse | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [adversarialResult, setAdversarialResult] = useState<AdversarialEvalResponse | null>(null);
  const [adversarialBusy, setAdversarialBusy] = useState(false);
  const [adversarialError, setAdversarialError] = useState('');
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
  const readbackTargetRef = useRef<{ sessionId: string; proposalId: string } | null>(null);
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

  const reportReadbackComplete = useCallback(async (target: { sessionId: string; proposalId: string }) => {
    try {
      const data = await requestJson<Partial<TurnResponse> & { session?: Partial<TurnSession> }>(
        '/api/readback/complete',
        jsonInit({ session_id: target.sessionId, proposal_id: target.proposalId }),
      );
      const current = resultsRef.current.layer;
      if (!mountedRef.current || current?.session.id !== target.sessionId || proposalIdOf(current) !== target.proposalId) return;
      const returnedProposal = data.proposal || data.session?.proposal;
      const currentProposal = proposalOf(current);
      const proposal = returnedProposal || (currentProposal
        ? { ...currentProposal, readback_status: data.readback_status || 'complete' }
        : currentProposal);
      const updated: TurnResponse = {
        ...current,
        ...data,
        session: { ...current.session, ...(data.session || {}), proposal: proposal || current.session.proposal },
        proposal: proposal || current.proposal,
        readback_status: data.readback_status || proposal?.readback_status || 'complete',
      };
      setComparisonResults((previous) => ({ ...previous, layer: updated }));
      setStatus('Full read back playback was acknowledged by the server. Confirmation remains a separate typed demo action.');
    } catch (error) {
      if (mountedRef.current) setStatus(`Read back audio ended, but the server could not record playback completion: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [setComparisonResults]);

  const refreshLedger = useCallback(async () => {
    if (!mountedRef.current) return null;
    try {
      const data = await requestJson<{ rows?: LedgerRow[]; unconfirmed?: UnconfirmedProposal[] }>('/api/ledger');
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (!mountedRef.current) return rows;
      setLedger(rows);
      setUnconfirmedProposals(Array.isArray(data.unconfirmed) ? data.unconfirmed : []);
      setLedgerError('');
      return rows;
    } catch (error) {
      if (mountedRef.current) setLedgerError(error instanceof Error ? error.message : 'Could not load the promise ledger.');
      return null;
    }
  }, []);

  const refreshAudits = useCallback(async (sessionIds: string[] = []) => {
    let failed = false;
    let loadedAny = false;
    try {
      const data = await requestJson<{ rows?: AuditRecord[]; audits?: AuditRecord[]; records?: AuditRecord[] }>('/api/audits');
      const rows = data.audits || data.rows || data.records || [];
      if (mountedRef.current) setAudits(Array.isArray(rows) ? rows : []);
      loadedAny = true;
    } catch {
      failed = true;
    }

    const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
    if (uniqueIds.length) {
      const settled = await Promise.all(uniqueIds.map(async (sessionId) => {
        try {
          const data = await requestJson<unknown>(`/api/session/${encodeURIComponent(sessionId)}/audit`);
          return [sessionId, auditFromResponse(data)] as const;
        } catch {
          return [sessionId, null] as const;
        }
      }));
      const found = settled.filter((entry): entry is readonly [string, AuditRecord] => Boolean(entry[1]));
      if (mountedRef.current && found.length) {
        setSessionAudits((previous) => ({ ...previous, ...Object.fromEntries(found) }));
        loadedAny = true;
      }
      if (found.length !== uniqueIds.length) failed = true;
    }
    if (mountedRef.current) setAuditError(failed && !loadedAny ? 'Audit records are unavailable.' : '');
  }, []);

  const refreshHandoffs = useCallback(async () => {
    try {
      const data = await requestJson<{ rows: HandoffRow[] }>('/api/handoffs');
      if (mountedRef.current) { setHandoffs(data.rows); setHandoffError(''); }
    } catch (error) {
      if (mountedRef.current) setHandoffError(error instanceof Error ? error.message : 'Could not load handoffs.');
    }
  }, []);

  const speak = useCallback(async (text?: string, readbackTarget: { sessionId: string; proposalId: string } | null = null) => {
    if (!text || !mountedRef.current || !activeRef.current) return;
    readbackTargetRef.current = readbackTarget;
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
        const target = readbackTargetRef.current;
        if (audioRef.current === audio && target) void reportReadbackComplete(target);
      };
      await audio.play();
      if (!mountedRef.current || !activeRef.current) audio.pause();
    } catch {
      if (mountedRef.current) {
        setPlaybackState('idle');
        setStatus('Voice unavailable; read back is shown as text.');
      }
    }
  }, [reportReadbackComplete]);

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
      void refreshAudits([layer.session.id]);
      void speak(layer.prompt);
    } catch (error) {
      if (mountedRef.current) setStatus(`Could not start the comparison: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refreshAudits, refreshLedger, setComparisonResults, speak]);

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
      await refreshHandoffs();
      await refreshAudits([ids.layer!]);
      const layerResult = responses.find(({ pipeline }) => pipeline === 'layer')?.response;
      if (layerResult?.prompt) await speak(layerResult.prompt, readbackTargetOf(layerResult));
    } catch (error) {
      if (mountedRef.current) setStatus(`Turn failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [applyResponse, refreshAudits, refreshLedger, refreshHandoffs, speak]);

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
    const proposalId = proposalIdOf(resultsRef.current.layer);
    if (!proposalId) {
      setStatus('Cannot confirm: the current proposal ID is missing. Send a fresh borrower turn.');
      return;
    }
    setBusy(true);
    setStatus(accepted ? 'Confirming the read back…' : 'Requesting a correction…');
    try {
      const response = await requestJson<TurnResponse>('/api/confirm', jsonInit({ session_id: sessionId, accepted, proposal_id: proposalId }));
      if (!mountedRef.current) return;
      applyResponse('layer', response);
      const rows = await refreshLedger();
      await refreshAudits([sessionId]);
      if (!accepted) {
        setStatus('Correction requested. Say the corrected amount, date, and payment method.');
      } else {
        const commitStatus = commitStatusOf(response);
        const statusAllowsSuccess = ['committed', 'written', 'duplicate', 'verified', 'success'].includes(commitStatus);
        const verified = response.verified_commit === true
          || Boolean(response.commit?.row || response.commit?.promise || response.ledger_row)
          || Boolean(rows && hasVerifiedLedgerRow(rows, response, sessionId, proposalId));
        if (statusAllowsSuccess && verified) {
          setStatus(commitStatus === 'duplicate'
            ? 'This proposal was already recorded. The existing Ledger row is verified.'
            : 'Confirmed promise verified in the guarded Ledger.');
        } else if (commitStatus.includes('conflict')) {
          setStatus('This proposal conflicts with an open promise. No new Ledger row was written.');
        } else if (commitStatus.includes('fail') || commitStatus === 'ledger_unavailable') {
          setStatus('The Ledger write failed. No promise was confirmed; retry or hand off for review.');
        } else {
          setStatus('Confirmation received, but no verified Ledger row is available. No success is shown.');
        }
      }
      if (response.prompt) await speak(response.prompt, readbackTargetOf(response));
    } catch (error) {
      if (mountedRef.current) setStatus(`Could not submit confirmation: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [applyResponse, refreshAudits, refreshLedger, speak]);

  const runEval = useCallback(async () => {
    if (!mountedRef.current || !activeRef.current) return;
    setEvalBusy(true);
    setEvalError('');
    setStatus('Running the supplied text fixtures…');
    try {
      const result = await requestJson<EvalResponse>('/api/eval');
      if (!mountedRef.current) return;
      setEvalResult(result);
      setStatus('Fixture evaluation complete.');
    } catch (error) {
      if (mountedRef.current) setEvalError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      if (mountedRef.current) setEvalBusy(false);
    }
  }, []);

  const runAdversarialEval = useCallback(async () => {
    if (!mountedRef.current || !activeRef.current) return;
    setAdversarialBusy(true);
    setAdversarialError('');
    setStatus('Running isolated adversarial conversations…');
    try {
      const result = await requestJson<AdversarialEvalResponse>('/api/eval/adversarial');
      if (!mountedRef.current) return;
      setAdversarialResult(result);
      setStatus('Adversarial conversation evaluation complete.');
      await refreshLedger();
      await refreshAudits();
    } catch (error) {
      if (mountedRef.current) setAdversarialError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      if (mountedRef.current) setAdversarialBusy(false);
    }
  }, [refreshAudits, refreshLedger]);

  const canTurn = active && Boolean(idsRef.current.layer) && !TERMINAL_STATES.has(results.layer?.session.state || '');
  const canConfirm = ['CONFIRMING', 'AWAITING_CONFIRMATION'].includes(results.layer?.session.state || '')
    && Boolean(proposalIdOf(results.layer));
  const prompt = results.layer?.prompt || '';

  useEffect(() => {
    mountedRef.current = true;
    void refreshLedger();
    void refreshHandoffs();
    void refreshAudits();
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
  }, [cancelRecording, refreshAudits, refreshLedger, refreshHandoffs]);

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
    unconfirmedProposals,
    ledgerError,
    refreshLedger,
    audits,
    sessionAudits,
    auditError,
    refreshAudits,
    handoffs,
    handoffError,
    refreshHandoffs,
    status,
    busy,
    recording,
    evalBusy,
    evalResult,
    evalError,
    adversarialResult,
    adversarialBusy,
    adversarialError,
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
    runAdversarialEval,
  };
}
