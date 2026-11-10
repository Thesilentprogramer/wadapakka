import { AnimatePresence, motion } from 'framer-motion';
import { Activity, AudioLines, Headphones, LoaderCircle, Mic2, Radio, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Meter } from './ui/Meter';
import { useLiveCall, type PipelineKind, type PipelineResult } from '../hooks/useLiveCall';

type LivePanelProps = {
  active?: boolean;
  onPipelineUpdate?: (kind: PipelineKind, data: PipelineResult) => void;
};

type LedgerRow = {
  session_id: string;
  amount_inr: number;
  pay_date: string;
  mode: string;
  commit_key: string;
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
  return decision ? decision.replaceAll('_', ' ') : 'Ready for a live call';
}

function ComparisonCard({ kind, result }: { kind: PipelineKind; result?: PipelineResult }) {
  const layer = kind === 'layer';
  const state = result?.session?.state;
  const captured = result?.session?.slots || {};
  return (
    <article className={`card min-w-0 p-4 ${layer ? 'border-[#cfe0fb] bg-[#f2f7ff]' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="m-0 text-[10px] font-bold uppercase tracking-[.12em] text-[var(--muted)]">{layer ? 'Reliability layer' : 'Naive pipeline'}</p>
          <h3 className="display m-0 mt-1 text-base font-semibold capitalize">{decisionLabel(result)}</h3>
        </div>
        <span className="pill !px-2 !py-1 !text-[9px]">{state ? state.replaceAll('_', ' ') : 'Ready'}</span>
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
    </article>
  );
}

export default function LivePanel({ active = true, onPipelineUpdate }: LivePanelProps) {
  const call = useLiveCall({ onPipelineUpdate });
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [ledgerError, setLedgerError] = useState('');
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalSummary, setEvalSummary] = useState('Eight synthetic transcripts. Audio results are reported separately.');
  const [evalError, setEvalError] = useState('');

  useEffect(() => {
    if (!active && (call.isRunning || call.isStarting)) call.endCall();
  }, [active, call.endCall, call.isRunning, call.isStarting]);

  useEffect(() => {
    let cancelled = false;
    const sessionIds = new Set([
      call.results.naive?.session?.id,
      call.results.layer?.session?.id,
    ].filter((id): id is string => Boolean(id)));

    if (!sessionIds.size) {
      setLedgerRows([]);
      setLedgerError('');
      return;
    }

    void fetch('/api/ledger')
      .then(async response => {
        let data: { rows?: LedgerRow[]; detail?: unknown };
        try { data = await response.json(); }
        catch { data = {}; }
        if (!response.ok) {
          const detail = typeof data.detail === 'string' ? data.detail : `Ledger request failed (${response.status})`;
          throw new Error(detail);
        }
        return Array.isArray(data.rows) ? data.rows : [];
      })
      .then(rows => {
        if (!cancelled) {
          setLedgerRows(rows.filter(row => sessionIds.has(row.session_id)));
          setLedgerError('');
        }
      })
      .catch(error => {
        if (!cancelled) setLedgerError(error instanceof Error ? error.message : String(error));
      });

    return () => { cancelled = true; };
  }, [call.results]);

  async function runEvaluation() {
    setEvalBusy(true);
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
      setEvalSummary(
        `${count} paired text fixtures: naive ${data.naive_correct}/${count} (${percent(data.naive_slot_accuracy)}%); layer ${data.layer_correct}/${count} (${percent(data.layer_slot_accuracy)}%). Different supplied transcripts; confirmation is simulated.`,
      );
    } catch (error) {
      setEvalError(error instanceof Error ? error.message : String(error));
    } finally {
      setEvalBusy(false);
    }
  }

  const buttonLabel = call.isStarting ? 'Cancel setup' : call.isRunning ? 'End live call' : 'Start live call';
  const buttonAction = call.isRunning || call.isStarting ? call.endCall : call.startCall;
  const buttonIcon = call.callState === 'Agent speaking' ? <Volume2 size={17} /> : call.isRunning ? <CircleStopIcon /> : <Mic2 size={17} />;

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
              const state = layer?.session?.state === 'WRITTEN' && value
                ? { label: 'Confirmed', state: 'confirmed' }
                : layer?.session?.state === 'CONFIRMING' && value
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
          <span className="hidden text-[10px] font-semibold uppercase tracking-[.1em] text-[var(--muted)] sm:inline">Naive writes early · Layer verifies first</span>
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
              <p className="muted m-0 mt-1 text-xs">Writes from this live call’s paired sessions.</p>
            </div>
            <span className="pill !text-[9px]">{ledgerRows.length} {ledgerRows.length === 1 ? 'write' : 'writes'}</span>
          </div>
          {ledgerError && <p role="status" className="mb-3 text-xs text-[var(--red)]">Ledger unavailable: {ledgerError}</p>}
          <div className="tablewrap">
            <table>
              <caption className="sr-only">Promises recorded by the live pipelines</caption>
              <thead><tr><th scope="col">Pipeline</th><th scope="col">Amount</th><th scope="col">Date</th><th scope="col">Mode</th><th scope="col">Commit</th></tr></thead>
              <tbody>
                {ledgerRows.length ? ledgerRows.map((row, index) => (
                  <tr key={`${row.commit_key}-${index}`}>
                    <td>{row.session_id === call.results.naive?.session?.id ? 'Naive' : 'Layer'}</td>
                    <td>₹{Number(row.amount_inr).toLocaleString('en-IN')}</td>
                    <td>{row.pay_date}</td>
                    <td>{row.mode}</td>
                    <td className="font-mono text-[10px]">{row.commit_key.slice(0, 8)}</td>
                  </tr>
                )) : <tr><td colSpan={5} className="muted">Confirmed live promises appear here.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel flex min-w-0 flex-col justify-between gap-5 p-5 sm:p-6">
          <div>
            <p className="m-0 text-[10px] font-bold uppercase tracking-[.12em] text-[var(--primary)]">Quality check</p>
            <h2 className="section-title m-0 mt-2">Fixture evaluation</h2>
            <p className="muted mb-0 mt-2 text-sm leading-relaxed">{evalSummary}</p>
            {evalError && <p role="status" className="mb-0 mt-2 text-xs text-[var(--red)]">{evalError}</p>}
          </div>
          <button type="button" className="button button-secondary w-fit" onClick={runEvaluation} disabled={evalBusy}>
            {evalBusy ? <LoaderCircle size={16} className="animate-spin" /> : <Activity size={16} />}
            {evalBusy ? 'Running evaluation…' : 'Run text eval'}
          </button>
        </section>
      </div>

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
