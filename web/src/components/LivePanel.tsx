import { AnimatePresence, motion } from 'framer-motion';
import { Activity, AlertCircle, AudioLines, ExternalLink, FileClock, Headphones, LoaderCircle, Mic2, Radio, UserRound, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Meter } from './ui/Meter';
import { useLiveCall, type PipelineKind, type PipelineResult } from '../hooks/useLiveCall';
import type { AdversarialEvalResponse, AuditRecord, LedgerRow, PromiseProposal, UnconfirmedProposal } from '../hooks/useTurnCall';
import { AdversarialEvaluation } from './TurnPanel';

type LivePanelProps = {
  active?: boolean;
  onPipelineUpdate?: (kind: PipelineKind, data: PipelineResult) => void;
};

type LiveHandoff = {
  session_id: string;
  reason: string;
  brief: string;
  transcript?: string;
  logged_at?: string;
  audit?: AuditRecord;
  audit_status?: string;
  readback_status?: string;
  unresolved_slot_candidates?: Record<string, unknown> | unknown[];
};

const slots: Array<{ key: string; label: string }> = [
  { key: 'amount_inr', label: 'Amount' },
  { key: 'pay_date', label: 'Payment date' },
  { key: 'mode', label: 'Payment method' },
];

function displaySlot(key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'amount_inr' && Number.isFinite(Number(value))) {
    return `₹${Number(value).toLocaleString('en-IN')}`;
  }
  return String(value);
}

function decisionLabel(result?: PipelineResult) {
  const decision = result?.event?.decision;
  if (decision === 'naive_write') return 'Would write (simulated)';
  return decision ? decision.replaceAll('_', ' ') : 'Ready for a live call';
}

function proposalOf(result?: PipelineResult): PromiseProposal | undefined {
  return result?.proposal || result?.session?.proposal || undefined;
}

function proposalId(proposal?: PromiseProposal) {
  return proposal?.id || proposal?.proposal_id || '';
}

function proposalSummary(proposal?: PromiseProposal) {
  if (!proposal) return 'Proposal fields unavailable';
  const amount = proposal.amount_inr ?? (proposal.amount_paise === undefined ? undefined : proposal.amount_paise / 100);
  return [amount === undefined ? null : `₹${Number(amount).toLocaleString('en-IN')}`, proposal.pay_date, proposal.mode].filter(Boolean).join(' · ') || 'Proposal fields unavailable';
}

function auditStatus(audit?: AuditRecord | null) {
  return String(audit?.audit_status || audit?.status || '—').replaceAll('_', ' ');
}

function auditDiscrepancy(audit?: AuditRecord | null) {
  if (!audit) return 'No audit discrepancy supplied.';
  if (typeof audit.discrepancy === 'string' && audit.discrepancy) return audit.discrepancy;
  if (audit.discrepancy && typeof audit.discrepancy === 'object') return JSON.stringify(audit.discrepancy);
  if (Array.isArray(audit.field_diffs) && audit.field_diffs.length) return audit.field_diffs.map((diff) => {
    const field = String(diff.field || diff.name || 'field');
    return `${field}: said ${String(diff.said ?? diff.parsed ?? diff.expected ?? '—')}, saved ${String(diff.saved ?? diff.ledger ?? diff.actual ?? diff.observed ?? '—')}`;
  }).join(' · ');
  return Array.isArray(audit.reasons) && audit.reasons.length ? audit.reasons.join(' · ') : 'No discrepancy supplied.';
}

function rowAmount(row: LedgerRow) {
  const amount = row.amount_inr ?? (row.amount_paise === undefined ? undefined : row.amount_paise / 100);
  return amount === undefined ? '—' : `₹${Number(amount).toLocaleString('en-IN')}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  let data: any;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status})`);
  return data as T;
}

function ComparisonCard({ kind, result }: { kind: PipelineKind; result?: PipelineResult }) {
  const layer = kind === 'layer';
  const state = result?.session?.state;
  const captured = result?.session?.slots || {};
  const status = layer
    ? state === 'WRITTEN' ? (result?.verified_commit ? 'Verified commit' : 'Verifying commit') : state?.replaceAll('_', ' ') || 'Ready'
    : decisionLabel(result) === 'Would write (simulated)' ? 'Simulated · would write' : 'Simulation only';
  return (
    <article className={`card min-w-0 p-4 ${layer ? 'border-[#cfe0fb] bg-[#f2f7ff]' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="m-0 text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{layer ? 'Reliability layer' : 'Naive pipeline'}</p>
          <h3 className="display m-0 mt-1 text-base font-semibold capitalize">{decisionLabel(result)}</h3>
        </div>
        <span className="pill !px-2 !py-1 !text-[9px]">{status}</span>
      </div>
      <p className="mt-3 min-h-10 break-words text-sm leading-relaxed text-[var(--muted)]">{result?.transcript || 'Start a live call to see the transcript.'}</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {slots.map(({ key, label }) => (
          <div key={key} className="min-w-0 rounded-lg bg-[#eef4fd] p-2">
            <span className="block truncate text-[9px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</span>
            <strong className="mt-1 block truncate text-xs font-semibold">{displaySlot(key, captured[key])}</strong>
          </div>
        ))}
      </div>
      {layer && (result?.commit_status || result?.audit_status || result?.evidence_id) && <p className="mb-0 mt-3 break-words text-[10px] text-[var(--muted)]">Commit {result.commit_status || 'pending'} · Audit {result.audit_status || 'pending'} · Evidence {result.evidence_id || '—'}</p>}
      {!layer && <p className="mb-0 mt-3 text-[10px] font-medium text-[var(--muted)]">Simulated comparison only. No Ledger row is created.</p>}
    </article>
  );
}

export default function LivePanel({ active = true, onPipelineUpdate }: LivePanelProps) {
  const call = useLiveCall({ onPipelineUpdate });
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [unconfirmedProposals, setUnconfirmedProposals] = useState<UnconfirmedProposal[]>([]);
  const [ledgerError, setLedgerError] = useState('');
  const [legacyEvalBusy, setLegacyEvalBusy] = useState(false);
  const [evalSummary, setEvalSummary] = useState('Legacy parser fixtures have not been run.');
  const [evalError, setEvalError] = useState('');
  const [adversarialBusy, setAdversarialBusy] = useState(false);
  const [adversarialResult, setAdversarialResult] = useState<AdversarialEvalResponse | null>(null);
  const [adversarialError, setAdversarialError] = useState('');
  const [audits, setAudits] = useState<AuditRecord[]>([]);
  const [sessionAudit, setSessionAudit] = useState<AuditRecord | null>(null);
  const [auditError, setAuditError] = useState('');
  const [handoffs, setHandoffs] = useState<LiveHandoff[]>([]);
  const [handoffError, setHandoffError] = useState('');

  useEffect(() => {
    if (!active && (call.isRunning || call.isStarting)) call.endCall();
  }, [active, call.endCall, call.isRunning, call.isStarting]);

  const refreshLedger = useCallback(async () => {
    try {
      const data = await requestJson<{ rows?: LedgerRow[]; unconfirmed?: UnconfirmedProposal[] }>('/api/ledger');
      setLedgerRows(Array.isArray(data.rows) ? data.rows : []);
      setUnconfirmedProposals(Array.isArray(data.unconfirmed) ? data.unconfirmed : []);
      setLedgerError('');
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const activeSessionId = call.results.layer?.session?.id;
  const refreshAuditData = useCallback(async () => {
    let failed = false;
    const [auditResult, handoffResult] = await Promise.allSettled([
      requestJson<{ rows?: AuditRecord[]; audits?: AuditRecord[] }>('/api/audits'),
      requestJson<{ rows?: LiveHandoff[] }>('/api/handoffs'),
    ]);
    if (auditResult.status === 'fulfilled') setAudits(auditResult.value.audits || auditResult.value.rows || []);
    else failed = true;
    if (handoffResult.status === 'fulfilled') setHandoffs(handoffResult.value.rows || []);
    else setHandoffError(handoffResult.reason instanceof Error ? handoffResult.reason.message : String(handoffResult.reason));
    if (activeSessionId) {
      try {
        const data = await requestJson<{ audit?: AuditRecord }>(`/api/session/${encodeURIComponent(activeSessionId)}/audit`);
        setSessionAudit(data.audit || null);
      } catch {
        failed = true;
      }
    }
    setAuditError(failed ? 'Some audit or handoff records could not be loaded.' : '');
  }, [activeSessionId]);

  useEffect(() => { if (active) { void refreshLedger(); void refreshAuditData(); } }, [active, call.results, refreshAuditData, refreshLedger]);

  async function runLegacyEvaluation() {
    setLegacyEvalBusy(true);
    setEvalError('');
    try {
      const response = await fetch('/api/eval');
      let data: any;
      try { data = await response.json(); }
      catch { data = {}; }
      if (!response.ok) {
        throw new Error(typeof data.detail === 'string' ? data.detail : `Evaluation failed (${response.status})`);
      }
      const count = Number(data.n) || 0;
      const percent = (value: unknown) => Math.round(Number(value) * 100);
      setEvalSummary(`${count} legacy single-turn parser fixtures: naive ${data.naive_correct}/${count} (${percent(data.naive_slot_accuracy)}%); layer ${data.layer_correct}/${count} (${percent(data.layer_slot_accuracy)}%). No conversation replay or Ledger writes.`);
    } catch (error) {
      setEvalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLegacyEvalBusy(false);
    }
  }

  async function runAdversarialEvaluation() {
    setAdversarialBusy(true);
    setAdversarialError('');
    try {
      const data = await requestJson<AdversarialEvalResponse>('/api/eval/adversarial');
      setAdversarialResult(data);
      await refreshLedger();
      await refreshAuditData();
    } catch (error) {
      setAdversarialError(error instanceof Error ? error.message : String(error));
    } finally {
      setAdversarialBusy(false);
    }
  }

  const buttonLabel = call.isStarting ? 'Cancel setup' : call.isRunning ? 'End live call' : 'Start live call';
  const buttonAction = call.isRunning || call.isStarting ? call.endCall : call.startCall;
  const buttonIcon = call.callState === 'Agent speaking' ? <Volume2 size={17} /> : call.isRunning ? <CircleStopIcon /> : <Mic2 size={17} />;
  const layerResult = call.results.layer;
  const layerSessionId = layerResult?.session?.id || '';
  const currentAudit: AuditRecord | null = sessionAudit
    || audits.find((item) => item.session_id === layerSessionId)
    || (layerResult?.audit && typeof layerResult.audit === 'object' ? layerResult.audit as AuditRecord : null);
  const queuedProposals: Array<{ sessionId: string; proposal: PromiseProposal; status: string; audit?: AuditRecord }> = [];
  const addQueuedProposal = (sessionId: string, proposal?: PromiseProposal | null, status = 'UNCONFIRMED', audit?: AuditRecord) => {
    if (!sessionId || !proposal) return;
    const id = proposalId(proposal);
    const committed = ledgerRows.some((row) => (id && row.proposal_id === id)
      || (row.session_id === sessionId && proposal.pay_date === row.pay_date && String(row.mode || '').toLowerCase() === String(proposal.mode || '').toLowerCase()
        && Number(row.amount_inr ?? (row.amount_paise === undefined ? NaN : row.amount_paise / 100)) === Number(proposal.amount_inr ?? (proposal.amount_paise === undefined ? NaN : proposal.amount_paise / 100))));
    if (committed || queuedProposals.some((item) => item.sessionId === sessionId && proposalId(item.proposal) === id)) return;
    queuedProposals.push({ sessionId, proposal, status, audit });
  };
  if (layerSessionId) addQueuedProposal(layerSessionId, proposalOf(layerResult), layerResult?.commit_status || layerResult?.session?.state, currentAudit || undefined);
  for (const item of unconfirmedProposals) addQueuedProposal(item.session_id, item.proposal, item.audit_status || 'UNCONFIRMED', audits.find((audit) => audit.session_id === item.session_id) || (item.session_id === layerSessionId ? currentAudit || undefined : undefined));
  for (const audit of [...audits, ...(sessionAudit ? [sessionAudit] : [])]) {
    const candidate = audit.proposal_snapshot || (audit.proposal && typeof audit.proposal === 'object' ? audit.proposal as PromiseProposal : null);
    if (audit.session_id) addQueuedProposal(audit.session_id, candidate, audit.audit_status || audit.status || 'UNCONFIRMED', audit);
  }
  const reviewAudits = [...audits, ...(sessionAudit ? [sessionAudit] : [])].filter((audit, index, all) => {
    const status = auditStatus(audit).toLowerCase();
    return (status.includes('review') || status.includes('discrep') || status.includes('unconfirmed'))
      && all.findIndex((item) => (item.audit_id && item.audit_id === audit.audit_id) || (!item.audit_id && item.session_id === audit.session_id)) === index;
  });

  return (
    <section className="space-y-4" aria-label="Live streaming call">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,.55fr)]">
        <section className="panel relative min-h-[405px] overflow-hidden border border-[#cfe2fa] bg-[radial-gradient(ellipse_at_50%_42%,rgba(159,204,255,.46),transparent_56%),linear-gradient(160deg,#e8f3ff,#ffffff_78%)] p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-[var(--primary)]"><Radio size={15} /><span className="text-[10px] font-bold uppercase tracking-[.14em]">Live streaming · L2</span></div>
              <h2 className="section-title m-0 mt-2 text-2xl">Live call</h2>
              <p className="muted m-0 mt-1 text-sm">Hear every promise. Catch every interruption.</p>
            </div>
            <span className="pill whitespace-nowrap" data-state={call.callState.toLowerCase().replaceAll(' ', '-')}>{call.callState}</span>
          </div>

          <div className="mx-auto flex max-w-xl flex-col items-center pt-6 text-center">
            <motion.div
              className="orb h-[112px] w-[112px] text-white sm:h-[124px] sm:w-[124px]"
              role="img"
              aria-label={call.isRunning ? 'Live microphone is active' : 'Microphone is on standby'}
              animate={{ scale: call.isRunning ? [1, 1.035, 1] : 1, boxShadow: call.isRunning ? ['0 0 0 12px #ffffffb0, 0 0 0 26px #dceaffbd, 0 22px 42px #194da247', '0 0 0 16px #ffffffc7, 0 0 0 31px #dceaffdf, 0 22px 42px #194da247', '0 0 0 12px #ffffffb0, 0 0 0 26px #dceaffbd, 0 22px 42px #194da247'] : '0 22px 42px #194da247' }}
              transition={{ duration: 3, repeat: call.isRunning ? Infinity : 0, ease: 'easeInOut' }}
            >
              {call.callState === 'Agent speaking' ? <AudioLines size={42} /> : <Mic2 size={43} />}
            </motion.div>
            <div className="mt-5 grid gap-1">
              <strong className="display text-xl font-semibold">{call.isRunning ? (call.callState === 'Agent speaking' ? 'Agent is speaking' : 'Listening for your promise') : 'Ready when you are'}</strong>
              <span role="status" aria-live="polite" className="max-w-xl text-sm text-[var(--muted)]">{call.status}</span>
            </div>
          </div>

          <div className="my-5 flex h-7 items-center justify-center gap-[5px]" aria-hidden="true">
            {Array.from({ length: 23 }, (_, index) => (
              <motion.span
                key={index}
                className="block w-[3px] rounded-full bg-[var(--primary)] opacity-60"
                style={{ height: `${7 + ((index * 11) % 17)}px` }}
                animate={call.isRunning ? { scaleY: [0.55, 1.55, 0.7], opacity: [0.35, 0.95, 0.5] } : { scaleY: 0.65, opacity: 0.35 }}
                transition={{ duration: 0.7 + (index % 4) * 0.13, repeat: call.isRunning ? Infinity : 0, delay: index * 0.025, ease: 'easeInOut' }}
              />
            ))}
          </div>

          <div className="mx-auto max-w-sm">
            <Meter value={call.micLevel} label="Microphone level" description="16 kHz mono PCM · echo cancellation enabled" />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
            <button
              type="button"
              className={`button ${call.isRunning || call.isStarting ? 'button-danger' : 'button-primary'} min-w-40`}
              onClick={buttonAction}
              aria-pressed={call.isRunning}
            >
              {buttonIcon}{buttonLabel}
            </button>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--ink)]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--primary)]"
                checked={call.headphonesMode}
                onChange={event => call.setHeadphonesMode(event.target.checked)}
              />
              <Headphones size={15} className="text-[var(--primary)]" />
              Headphones mode
            </label>
            <span className="text-[11px] text-[var(--amber)]">Recommended for live mode</span>
          </div>
        </section>

        <aside className="panel min-w-0 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="m-0 text-[10px] font-bold uppercase tracking-[.13em] text-[var(--primary)]">Verification</p>
              <h2 className="section-title m-0 mt-2 text-xl">Promise capture</h2>
            </div>
            <Activity size={18} className="mt-1 text-[var(--primary)]" />
          </div>
          <div className="mt-6 grid gap-2.5">
            {slots.map(({ key, label }) => {
              const layer = call.results.layer;
              const value = layer?.session?.slots?.[key];
              const state = layer?.session?.state === 'WRITTEN' && layer.verified_commit === true && value
                ? { label: 'Confirmed', state: 'confirmed' }
                : ['CONFIRMING', 'READBACK_PENDING', 'AWAITING_CONFIRMATION'].includes(layer?.session?.state || '') && value
                  ? { label: 'Reading back', state: 'reading' }
                  : { label: 'Pending', state: 'pending' };
              return (
                <motion.div layout key={key} className="slot-card flex min-h-[78px] items-center justify-between gap-3" data-state={state.state}>
                  <div className="min-w-0">
                    <span className="block text-[10px] font-bold uppercase tracking-[.1em] text-[var(--muted)]">{label}</span>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.strong key={String(value ?? '')} className="mt-1 block truncate text-lg font-semibold" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
                        {displaySlot(key, value)}
                      </motion.strong>
                    </AnimatePresence>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${state.state === 'confirmed' ? 'bg-[#e6f6ec] text-[var(--green)]' : state.state === 'reading' ? 'bg-[#fff3d9] text-[var(--amber)]' : 'bg-[#edf1f7] text-[var(--muted)]'}`}>
                    {state.label}
                  </span>
                </motion.div>
              );
            })}
          </div>
          <AnimatePresence>
            {call.handoffBrief && (
              <motion.div className="mt-4 rounded-xl border border-[#f5d99c] bg-[#fff7e9] p-4 text-sm text-[var(--ink)]" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}>
                <strong className="block text-[10px] uppercase tracking-[.12em] text-[var(--amber)]">Human handoff brief</strong>
                <p className="mb-0 mt-2 leading-relaxed">{call.handoffBrief}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
      </div>

      <section className="grid gap-3 sm:grid-cols-3" aria-label="Live call latency statistics">
        {[
          { label: 'STT latency', value: call.stats.final },
          { label: 'First audio byte', value: call.stats.audio },
          { label: 'Barge-in reaction', value: call.stats.barge },
        ].map(({ label, value }) => (
          <div className="card flex items-end justify-between gap-3 px-5 py-4" key={label}>
            <span className="text-[10px] font-bold uppercase tracking-[.1em] text-[var(--muted)]">{label}</span>
            <strong className="display text-xl font-semibold tabular-nums">{value === null ? '—' : `${value} ms avg`}</strong>
          </div>
        ))}
      </section>

      <section className="space-y-3" aria-label="Live pipeline comparison">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="section-title m-0">Live comparison</h2>
            <p className="muted m-0 mt-1 text-xs">Finalized caller speech updates both pipelines.</p>
          </div>
          <span className="hidden text-[10px] font-semibold uppercase tracking-[.1em] text-[var(--muted)] sm:inline">Naive is simulated · Layer uses a guarded commit</span>
        </div>
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          <ComparisonCard kind="naive" result={call.results.naive} />
          <ComparisonCard kind="layer" result={call.results.layer} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,.8fr)]">
        <section className="panel min-w-0 p-5 sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="section-title m-0">Promise ledger</h2>
              <p className="muted m-0 mt-1 text-xs">Actual guarded commits only. The simulated naive comparison stays out.</p>
            </div>
            <div className="flex items-center gap-2"><span className="pill !text-[9px]">{ledgerRows.length} {ledgerRows.length === 1 ? 'write' : 'writes'}</span><button type="button" className="button button-secondary" onClick={() => void refreshLedger()}>Refresh</button></div>
          </div>
          {ledgerError && <p role="status" className="mb-3 text-xs text-[var(--red)]">Ledger unavailable: {ledgerError}</p>}
          <div className="tablewrap">
            <table>
              <caption className="sr-only">Actual guarded promise commits and their transcript evidence</caption>
              <thead><tr><th scope="col">Amount</th><th scope="col">Date</th><th scope="col">Mode</th><th scope="col">Status</th><th scope="col">Confirmed via</th><th scope="col">Evidence</th></tr></thead>
              <tbody>
                {ledgerRows.length ? ledgerRows.map((row, index) => (
                  <tr key={row.promise_id || row.commit_key || `${row.session_id || 'row'}-${index}`}>
                    <td>{rowAmount(row)}</td>
                    <td>{row.pay_date || '—'}</td>
                    <td>{row.mode || '—'}</td>
                    <td>{String(row.review_status || row.status || 'OPEN').replaceAll('_', ' ')}</td>
                    <td>{String(row.confirmation_source || row.source || '—').replaceAll('_', ' ')}</td>
                    <td>{row.promise_id ? <a href={`/api/ledger/${encodeURIComponent(row.promise_id)}/evidence`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-[var(--primary)] underline-offset-2 hover:underline"><ExternalLink size={12} />{row.confirmation_evidence_id || row.evidence_id ? `Evidence ${(row.confirmation_evidence_id || row.evidence_id || '').slice(0, 8)}` : 'Open evidence'}</a> : row.confirmation_evidence_id || row.evidence_id || 'Unavailable'}</td>
                  </tr>
                )) : <tr><td colSpan={6} className="muted">No guarded commits yet. Proposals remain separate until a verified write exists.</td></tr>}
              </tbody>
            </table>
          </div>
          <section className="mt-5 border-t border-[color:var(--line)] pt-4" aria-labelledby="live-proposal-queue-title">
            <div className="flex items-center gap-2"><FileClock size={15} className="text-[var(--amber)]" aria-hidden="true" /><h3 id="live-proposal-queue-title" className="text-sm font-semibold text-[var(--ink)]">Unconfirmed proposal queue</h3><span className="pill !px-2 !py-1 !text-[9px]">{queuedProposals.length}</span></div>
            {!queuedProposals.length ? <p className="mt-2 text-sm text-[var(--muted)]">Pending live proposals appear here until they have a verified Ledger row.</p> : <ul className="mt-2 space-y-2">{queuedProposals.map(({ sessionId, proposal, status, audit }, index) => <li key={`${sessionId}-${proposalId(proposal) || index}`} className="rounded-xl bg-[#fff8ea] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{proposalSummary(proposal)}</strong><span className="rounded-full bg-white px-2 py-1 text-[9px] font-bold uppercase text-[var(--amber)]">{String(status).replaceAll('_', ' ')}</span></div><p className="mb-0 mt-1 text-xs text-[var(--muted)]">Session {sessionId.slice(0, 8)} · read back {String(proposal.readback_status || 'not verified').replaceAll('_', ' ')} · audit {auditStatus(audit)}</p></li>)}</ul>}
          </section>
        </section>

        <section className="panel flex min-w-0 flex-col justify-between gap-5 p-5 sm:p-6">
          <div>
            <h2 className="section-title m-0">Legacy parser fixtures</h2>
            <p className="muted mb-0 mt-2 text-sm leading-relaxed">{evalSummary}</p>
            {evalError && <p role="status" className="mb-0 mt-2 text-xs text-[var(--red)]">{evalError}</p>}
          </div>
          <button type="button" className="button button-secondary w-fit" onClick={runLegacyEvaluation} disabled={legacyEvalBusy}>
            {legacyEvalBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Activity size={16} />}
            {legacyEvalBusy ? 'Running legacy fixtures…' : 'Run parser fixtures'}
          </button>
        </section>
      </div>

      <AdversarialEvaluation result={adversarialResult} busy={adversarialBusy} error={adversarialError} onRun={() => void runAdversarialEvaluation()} />

      <section className="panel p-5 sm:p-6" aria-labelledby="live-handoff-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 id="live-handoff-title" className="section-title m-0">Handoff and audit desk</h2><p className="muted mb-0 mt-1 text-sm">Review reasons, transcript context, unresolved fields, and said-vs-saved differences.</p></div>
          <button type="button" className="button button-secondary" onClick={() => void refreshAuditData()}>Refresh desk</button>
        </div>
        {handoffError && <p role="alert" className="mt-3 text-xs text-[var(--red)]">Handoffs unavailable: {handoffError}</p>}
        {auditError && <p role="status" className="mt-2 text-xs text-[var(--red)]">{auditError}</p>}
        {call.handoffBrief && <article className="mt-4 rounded-xl bg-[#fff7e9] p-4"><div className="flex flex-wrap items-center gap-2"><UserRound size={15} className="text-[var(--amber)]" aria-hidden="true" /><strong className="text-sm capitalize">{String(layerResult?.event?.handoff_reason || layerResult?.event?.reason || 'Human handoff').replaceAll('_', ' ')}</strong><span className="rounded-full bg-[#e7f6ed] px-2 py-1 text-[9px] font-bold uppercase text-[var(--green)]">{layerSessionId && !ledgerRows.some((row) => row.session_id === layerSessionId) ? '0 Ledger writes' : 'Review required'}</span></div><p className="mb-0 mt-2 text-sm leading-relaxed">{call.handoffBrief}</p>{layerResult?.transcript && <p className="mb-0 mt-2 text-xs text-[var(--muted)]"><strong className="text-[var(--ink)]">Last relevant transcript:</strong> “{layerResult.transcript}”</p>}{currentAudit && <p className="mb-0 mt-2 break-words text-xs text-[var(--muted)]"><strong className="text-[var(--ink)]">Audit discrepancy:</strong> {auditDiscrepancy(currentAudit)}</p>}{layerSessionId && <a href={`/api/session/${encodeURIComponent(layerSessionId)}/audit`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--primary)]">Open session audit <ExternalLink size={12} /></a>}</article>}
        {!call.handoffBrief && handoffs.length === 0 && <p className="mt-3 text-sm text-[var(--muted)]">No handoff cases are reported.</p>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">{handoffs.map((row, index) => { const safety = ['hardship', 'wrong_person', 'dispute'].some((reason) => row.reason.toLowerCase().includes(reason)); const hasWrite = ledgerRows.some((item) => item.session_id === row.session_id); const audit = row.audit || audits.find((item) => item.session_id === row.session_id) || (row.session_id === layerSessionId ? currentAudit : null); return <article key={`${row.session_id}-${row.logged_at || index}`} className="rounded-xl bg-[#f7f9fd] p-3"><div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 text-xs font-semibold capitalize text-[var(--amber)]"><UserRound size={13} />{row.reason.replaceAll('_', ' ')}</span>{safety && !hasWrite && <span className="rounded-full bg-[#e7f6ed] px-2 py-1 text-[9px] font-bold uppercase text-[var(--green)]">0 Ledger writes</span>}</div><p className="mb-0 mt-2 text-xs leading-relaxed">{row.brief}</p>{row.transcript && <p className="mb-0 mt-2 text-xs text-[var(--muted)]"><strong className="text-[var(--ink)]">Last relevant transcript:</strong> “{row.transcript}”</p>}{row.unresolved_slot_candidates && <p className="mb-0 mt-2 break-words text-xs text-[var(--muted)]"><strong className="text-[var(--ink)]">Unresolved slots:</strong> {JSON.stringify(row.unresolved_slot_candidates)}</p>}<p className="mb-0 mt-2 text-xs text-[var(--muted)]"><strong className="text-[var(--ink)]">Read-back:</strong> {row.readback_status || 'not supplied'}{audit && <> · <strong className="text-[var(--ink)]">{auditStatus(audit)}:</strong> {auditDiscrepancy(audit)}</>}</p><a href={`/api/session/${encodeURIComponent(row.session_id)}/audit`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--primary)]">Open audit <ExternalLink size={12} /></a></article>; })}</div>
        {!!reviewAudits.length && <div className="mt-4 border-t border-[color:var(--line)] pt-4"><div className="flex items-center gap-2"><AlertCircle size={15} className="text-[var(--amber)]" /><h3 className="text-sm font-semibold">Said vs saved discrepancies</h3></div>{reviewAudits.map((audit, index) => <article key={audit.audit_id || audit.session_id || index} className="mt-2 rounded-xl bg-[#fff4e1] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs">{audit.session_id ? `Session ${audit.session_id.slice(0, 8)}` : audit.audit_id || 'Audit review'}</strong><span className="text-[9px] font-bold uppercase text-[var(--amber)]">{auditStatus(audit)}</span></div><p className="mb-0 mt-2 break-words text-xs leading-relaxed">{auditDiscrepancy(audit)}</p>{audit.session_id && <a href={`/api/session/${encodeURIComponent(audit.session_id)}/audit`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--primary)]">Open audit <ExternalLink size={12} /></a>}</article>)}</div>}
      </section>

      <details className="panel p-0">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2"><Activity size={16} className="text-[var(--primary)]" /><strong className="display text-base">Observability timeline</strong></span>
          <span className="text-xs text-[var(--muted)]">Newest first · {call.timeline.length} events</span>
        </summary>
        <ol className="timeline-list max-h-80 overflow-y-auto px-5 pb-3">
          <AnimatePresence initial={false}>
            {call.timeline.length ? call.timeline.map(entry => (
              <motion.li key={entry.id} data-kind={entry.kind} initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.17 }}>
                <time>{entry.time}</time>
                <div className="min-w-0"><strong className={`mb-1 block ${entry.kind === 'error' || entry.kind === 'interrupted' ? 'text-[var(--red)]' : entry.kind === 'turn' ? 'text-[var(--primary)]' : ''}`}>{entry.title}</strong><span>{entry.detail || '—'}</span></div>
              </motion.li>
            )) : <li><time>—</time><div><strong className="mb-1 block">No live events yet</strong><span>Start a call to see speech, decisions, and audio timing.</span></div></li>}
          </AnimatePresence>
        </ol>
      </details>
    </section>
  );
}

function CircleStopIcon() {
  return <span aria-hidden="true" className="inline-block h-3.5 w-3.5 rounded-[4px] bg-current" />;
}
