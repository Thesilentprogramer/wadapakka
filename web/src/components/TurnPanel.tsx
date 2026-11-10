import { AnimatePresence, motion } from 'framer-motion';
import {
  AudioLines,
  ArrowRight,
  Check,
  CircleStop,
  Clock3,
  FileCheck2,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from './ui/Button';
import { SpotlightCard } from './ui/SpotlightCard';
import { useTurnCall, type Pipeline, type Slots, type TurnEvent, type TurnResponse } from '../hooks/useTurnCall';

const SLOT_FIELDS: Array<{ key: keyof Slots; label: string }> = [
  { key: 'amount_inr', label: 'Amount' },
  { key: 'pay_date', label: 'Payment date' },
  { key: 'mode', label: 'Payment method' },
];

const DECISION_LABELS: Record<string, string> = {
  naive_write: 'Promise written without confirmation',
  naive_incomplete: 'Waiting for missing details',
  readback: 'Read back required',
  need_more_slots: 'Clarification required',
  confirmed_write: 'Confirmed promise written',
  duplicate_confirmation: 'Duplicate write prevented',
  correction_requested: 'Correction requested',
  handoff: 'Human handoff',
  refused: 'Borrower refused',
};

function readable(value: string | undefined) {
  if (!value) return 'No decision yet';
  return DECISION_LABELS[value] || value.replaceAll('_', ' ');
}

function slotValue(key: keyof Slots, value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'amount_inr' && Number.isFinite(Number(value))) {
    return `₹${Number(value).toLocaleString('en-IN')}`;
  }
  return String(value);
}

function getSlots(response?: TurnResponse): Slots {
  return response?.verdict?.slots || response?.session.slots || {};
}

function slotState(response: TurnResponse | undefined, key: keyof Slots, pipeline: Pipeline) {
  const value = getSlots(response)[key];
  const state = response?.session.state;
  if (pipeline === 'layer') {
    if (state === 'WRITTEN' && value) return { label: 'Confirmed', kind: 'confirmed' };
    if (state === 'CONFIRMING' && value) return { label: 'Read back', kind: 'review' };
    if (value) return { label: 'Captured', kind: 'captured' };
  } else {
    if (state === 'WRITTEN' && value) return { label: 'Written', kind: 'written' };
    if (value) return { label: 'Captured', kind: 'captured' };
  }
  return { label: 'Pending', kind: 'pending' };
}

function decisionDetail(response: TurnResponse | undefined, pipeline: Pipeline) {
  const decision = response?.event?.decision;
  if (pipeline === 'naive') {
    return decision === 'naive_write'
      ? 'The first complete parse went straight to the ledger without a read back.'
      : 'The naive path needs an amount, date, and payment method before it can write.';
  }
  if (response?.verdict?.slots?.date_note === 'kal_ambiguous') {
    return '“Kal” can mean yesterday or tomorrow. Ask for an exact date before continuing.';
  }
  if (decision === 'readback') return 'Nothing is written until the borrower confirms all three details.';
  if (decision === 'confirmed_write') return 'The borrower confirmed the read back. One idempotent ledger entry was recorded.';
  if (decision === 'handoff') return 'Automation stopped. Use the handoff brief to continue with a person.';
  return 'Critical details stay pending until the spoken read back is confirmed.';
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function ReadbackPlayer({ text, state, currentTime, duration, onToggle, onSeek }: {
  text: string;
  state: 'idle' | 'playing' | 'paused' | 'ended';
  currentTime: number;
  duration: number;
  onToggle: (text?: string) => void;
  onSeek: (time: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--line)] bg-[#f1f5fc] p-3 sm:gap-4 sm:p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e5f0ff] text-[var(--primary)]">
        <AudioLines size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-[var(--ink)]">Agent voice</p>
            <p className="mt-0.5 truncate text-xs text-[var(--muted)]" title={text}>{text || 'The read back appears here after a borrower turn.'}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="h-9 min-h-9 w-9 shrink-0 p-0"
            onClick={() => onToggle(text)}
            disabled={!text}
            aria-label={state === 'playing' ? 'Pause agent voice' : 'Play agent voice'}
          >
            {state === 'playing' ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[10px] tabular-nums text-[var(--muted)]">
          <time>{formatTime(currentTime)}</time>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0)}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(event) => onSeek(Number(event.target.value))}
            disabled={!duration}
            className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--primary)] disabled:cursor-default"
            aria-label="Seek through agent read back"
          />
          <time>{duration ? formatTime(duration) : '0:00'}</time>
        </div>
      </div>
    </div>
  );
}

function SlotCards({ response, pipeline }: { response?: TurnResponse; pipeline: Pipeline }) {
  const slots = getSlots(response);
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {SLOT_FIELDS.map(({ key, label }) => {
        const value = slots[key];
        const state = slotState(response, key, pipeline);
        return (
          <motion.div
            key={key}
            layout
            className="slot-card min-w-0"
            data-state={state.kind}
            aria-label={`${label}: ${slotValue(key, value)}, ${state.label}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.09em] text-[var(--muted)]">{label}</span>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={state.label}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16 }}
                  className={`shrink-0 text-[10px] font-bold uppercase tracking-wide ${state.kind === 'confirmed' ? 'text-[var(--green)]' : state.kind === 'review' ? 'text-[var(--amber)]' : 'text-[var(--muted)]'}`}
                >
                  {state.label}
                </motion.span>
              </AnimatePresence>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={String(value ?? '')}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.18 }}
                className="mt-3 break-words text-lg font-semibold leading-tight text-[var(--ink)]"
              >
                {slotValue(key, value)}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}

function PipelinePanel({ response, pipeline, onToggleReadback, onSeekReadback, playbackState, playbackTime, playbackDuration, onConfirm, canConfirm, busy }: {
  response?: TurnResponse;
  pipeline: Pipeline;
  onToggleReadback: (text?: string) => void;
  onSeekReadback: (time: number) => void;
  playbackState: 'idle' | 'playing' | 'paused' | 'ended';
  playbackTime: number;
  playbackDuration: number;
  onConfirm: (accepted: boolean) => void;
  canConfirm: boolean;
  busy: boolean;
}) {
  const isLayer = pipeline === 'layer';
  const decision = response?.event?.decision;
  const transcript = response?.transcript;
  const handoff = isLayer ? response?.handoff_brief : undefined;
  const detail = decisionDetail(response, pipeline);

  const content = (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-[color:var(--line)] px-5 py-5 sm:px-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl ${isLayer ? 'bg-[#e5f0ff] text-[var(--primary)]' : 'bg-[#edf1f7] text-[var(--muted)]'}`}>
            {isLayer ? <ShieldCheck size={18} aria-hidden="true" /> : <AudioLines size={18} aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <h2 className="section-title text-lg">{isLayer ? 'Reliability layer' : 'Naive pipeline'}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{isLayer ? 'Normalize · read back · confirm · commit' : 'First complete parse writes immediately'}</p>
          </div>
        </div>
        <span className="pill shrink-0 text-[10px] font-bold tracking-[0.08em]">
          {isLayer ? 'CONFIRM BY DEFAULT' : 'UNVERIFIED'}
        </span>
      </header>

      <div className="space-y-5 p-5 sm:p-6">
        <section aria-label={`${isLayer ? 'Layer' : 'Naive'} transcript`}>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Borrower transcript</p>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={transcript || 'empty'}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.18 }}
              className={`min-h-[3.5rem] text-lg font-medium leading-relaxed ${transcript ? 'text-[var(--ink)]' : 'text-[var(--muted)]'}`}
            >
              {transcript || 'Start comparison, then speak or type a borrower line'}
            </motion.p>
          </AnimatePresence>
        </section>

        <section aria-label={`${isLayer ? 'Layer' : 'Naive'} extracted slots`}>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{isLayer ? 'Critical slots' : 'Extracted slots'}</p>
          <SlotCards response={response} pipeline={pipeline} />
        </section>

        <section className="border-t border-[color:var(--line)] pt-4" aria-label={`${isLayer ? 'Layer' : 'Naive'} decision`}>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Decision</p>
          <motion.p key={decision || 'none'} initial={{ opacity: 0.6 }} animate={{ opacity: 1 }} className="text-base font-semibold text-[var(--ink)]">
            {readable(decision)}
          </motion.p>
          <p className="mt-1.5 min-h-10 text-sm leading-relaxed text-[var(--muted)]">{detail}</p>

          {isLayer && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="primary" onClick={() => onConfirm(true)} disabled={!canConfirm || busy}>
                <Check size={15} aria-hidden="true" /> Confirm: haan
              </Button>
              <Button type="button" variant="secondary" onClick={() => onConfirm(false)} disabled={!canConfirm || busy}>
                <X size={15} aria-hidden="true" /> Correct: nahi
              </Button>
            </div>
          )}
        </section>

        {isLayer && (
          <section>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Agent read back</p>
            <ReadbackPlayer
              text={response?.prompt || ''}
              state={playbackState}
              currentTime={playbackTime}
              duration={playbackDuration}
              onToggle={onToggleReadback}
              onSeek={onSeekReadback}
            />
            <AnimatePresence>
              {handoff && (
                <motion.div
                  initial={{ opacity: 0, height: 0, y: 8 }}
                  animate={{ opacity: 1, height: 'auto', y: 0 }}
                  exit={{ opacity: 0, height: 0, y: -8 }}
                  className="mt-3 overflow-hidden rounded-xl border border-[#f5d99c] bg-[#fff7e9] p-4 text-sm leading-relaxed text-[var(--amber)]"
                >
                  <span className="mb-1 flex items-center gap-2 font-semibold"><UserRound size={15} aria-hidden="true" /> Human handoff brief</span>
                  {handoff}
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        )}
      </div>
    </>
  );

  const className = `min-w-0 overflow-hidden ${isLayer ? '' : 'panel'}`;
  return isLayer
    ? <SpotlightCard className={className}>{content}</SpotlightCard>
    : <article className={className}>{content}</article>;
}

function timelineEntries(results: Partial<Record<Pipeline, TurnResponse>>) {
  return (['naive', 'layer'] as Pipeline[])
    .flatMap((pipeline) => (results[pipeline]?.session.turns || []).map((event, index) => ({ pipeline, event, key: `${pipeline}-${index}` })))
    .reverse();
}

function eventSlots(event: TurnEvent): Slots {
  return event.verdict?.slots || event.slots || {};
}

function TurnTimeline({ results }: { results: Partial<Record<Pipeline, TurnResponse>> }) {
  const entries = timelineEntries(results);
  return (
    <ol className="timeline-list">
      {entries.length === 0 ? (
        <li className="flex gap-3 py-4 text-sm text-[var(--muted)]">
          <Clock3 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>Record or type a borrower line to see each pipeline decision.</span>
        </li>
      ) : entries.map(({ pipeline, event, key }, index) => {
        const slots = eventSlots(event);
        const values = [
          slots.amount_inr ? `₹${Number(slots.amount_inr).toLocaleString('en-IN')}` : null,
          slots.pay_date,
          slots.mode,
        ].filter(Boolean).join(' / ');
        return (
          <li key={key} className="grid grid-cols-[62px_minmax(0,1fr)] gap-3 py-3">
            <span className="pt-0.5 text-xs font-medium text-[var(--primary)]">Turn {index + 1}</span>
            <div className="min-w-0">
              <strong className="block text-sm font-semibold text-[var(--ink)]">{pipeline === 'naive' ? 'Naive' : 'Layer'} · {readable(event.decision)}</strong>
              <span className="mt-1 block break-words text-xs leading-relaxed text-[var(--muted)]">
                “{event.transcript}”{values ? ` · ${values}` : ''} · {event.latency_ms} ms
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PromiseLedger({ rows, results }: { rows: ReturnType<typeof useTurnCall>['ledger']; results: Partial<Record<Pipeline, TurnResponse>> }) {
  const naiveId = results.naive?.session.id;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[540px] border-collapse text-left text-sm">
        <caption className="sr-only">Promises recorded by the turn-based pipelines</caption>
        <thead>
          <tr className="border-b border-[color:var(--line)] text-xs text-[var(--muted)]">
            <th scope="col" className="px-2 py-3 font-semibold">Pipeline</th>
            <th scope="col" className="px-2 py-3 font-semibold">Amount</th>
            <th scope="col" className="px-2 py-3 font-semibold">Date</th>
            <th scope="col" className="px-2 py-3 font-semibold">Method</th>
            <th scope="col" className="px-2 py-3 font-semibold">Commit</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={5} className="px-2 py-5 text-sm text-[var(--muted)]">Confirmed promises appear here after a call.</td></tr>
          ) : rows.map((row) => (
            <tr key={row.commit_key} className="border-b border-[color:var(--line)] last:border-0">
              <td className="px-2 py-3 font-medium text-[var(--primary)]">{row.session_id === naiveId ? 'Naive' : row.session_id === results.layer?.session.id ? 'Layer' : 'Other session'}</td>
              <td className="px-2 py-3">₹{row.amount_inr.toLocaleString('en-IN')}</td>
              <td className="px-2 py-3">{row.pay_date}</td>
              <td className="px-2 py-3">{row.mode}</td>
              <td className="px-2 py-3 font-mono text-xs text-[var(--muted)]">{row.commit_key.slice(0, 8)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TurnPanel({ active = true }: { active?: boolean }) {
  const [transcript, setTranscript] = useState('');
  const {
    results,
    ledger,
    ledgerError,
    refreshLedger,
    handoffs,
    handoffError,
    refreshHandoffs,
    status,
    busy,
    recording,
    evalBusy,
    evalResult,
    evalError,
    playbackState,
    playbackTime,
    playbackDuration,
    canTurn,
    canConfirm,
    startComparison,
    submitText,
    toggleRecording,
    confirm,
    toggleReadback,
    seekReadback,
    runEval,
  } = useTurnCall(active);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!transcript.trim() || busy || !canTurn) return;
    const value = transcript;
    setTranscript('');
    await submitText(value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const started = Boolean(results.layer);
  const terminal = results.layer && ['WRITTEN', 'HANDOFF', 'REFUSED'].includes(results.layer.session.state);
  const stateLabel = !started ? 'Idle' : terminal ? results.layer?.session.state : busy ? 'Processing' : 'Ready';

  return (
    <section className="space-y-5" aria-label="L1 turn-based comparison">
      <form onSubmit={handleSubmit} className="panel p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center">
          <div className="flex shrink-0 items-center gap-3 xl:mr-1">
            <Button type="button" variant="primary" className="min-h-11" onClick={startComparison} disabled={busy}>
              {busy && !started ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
              Start comparison
            </Button>
            <Button
              type="button"
              variant={recording ? 'danger' : 'secondary'}
              className="min-h-11"
              onClick={toggleRecording}
              disabled={!canTurn || busy}
              aria-pressed={recording}
              aria-label={recording ? 'Stop recording turn' : 'Record borrower turn'}
            >
              {recording ? <CircleStop size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
              {recording ? 'Stop recording' : 'Record turn'}
            </Button>
          </div>

          <label className="sr-only" htmlFor="borrower-turn">Borrower transcript</label>
          <textarea
            id="borrower-turn"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a borrower promise in Hinglish"
            rows={1}
            className="min-h-11 min-w-0 flex-1 resize-y rounded-xl border border-[color:var(--line)] bg-[#f7f9fe] px-4 py-3 text-sm text-[var(--ink)] placeholder:text-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]"
            disabled={!canTurn || busy}
          />

          <Button type="submit" variant="secondary" className="min-h-11" disabled={!canTurn || busy || !transcript.trim()}>
            {busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
            Send turn
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <button type="button" className="sample-line" disabled={busy} onClick={() => { setTranscript('main parso dhai hazaar rupaye UPI se de dunga'); document.getElementById('borrower-turn')?.focus() }}>Use sample: “parso dhai hazaar” <ArrowRight size={14} aria-hidden="true" /></button>
          <p className="flex min-w-0 items-center gap-2 text-sm text-[var(--muted)]" role="status" aria-live="polite">
            <span className={`h-2 w-2 rounded-full ${busy ? 'animate-pulse bg-[var(--amber)]' : started ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'}`} aria-hidden="true" />
            <span>{status}</span>
          </p>
          <span className="pill inline-flex items-center gap-2 text-xs"><span className={`h-1.5 w-1.5 rounded-full ${busy ? 'bg-[var(--amber)]' : started ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]'}`} />{stateLabel}</span>
        </div>
      </form>

      <div className="grid gap-4 xl:grid-cols-2">
        <PipelinePanel
          response={results.naive}
          pipeline="naive"
          onToggleReadback={toggleReadback}
          onSeekReadback={seekReadback}
          playbackState={playbackState}
          playbackTime={playbackTime}
          playbackDuration={playbackDuration}
          onConfirm={confirm}
          canConfirm={false}
          busy={busy}
        />
        <PipelinePanel
          response={results.layer}
          pipeline="layer"
          onToggleReadback={toggleReadback}
          onSeekReadback={seekReadback}
          playbackState={playbackState}
          playbackTime={playbackTime}
          playbackDuration={playbackDuration}
          onConfirm={confirm}
          canConfirm={canConfirm}
          busy={busy}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
        <section className="panel min-w-0 p-5 sm:p-6" aria-labelledby="turn-observability-title">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="section-title" id="turn-observability-title">Turn observability</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">Transcript → slots → decision → latency</p>
            </div>
            <span className="pill">{timelineEntries(results).length} events</span>
          </div>
          <TurnTimeline results={results} />
        </section>

        <section className="panel min-w-0 p-5 sm:p-6" aria-labelledby="promise-ledger-title">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="section-title" id="promise-ledger-title">Promise ledger</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">Idempotent writes from these two sessions</p>
            </div>
            <div className="flex items-center gap-2"><span className="pill inline-flex items-center gap-2"><FileCheck2 size={13} aria-hidden="true" />{ledger.length} {ledger.length === 1 ? 'write' : 'writes'}</span><Button type="button" variant="secondary" onClick={() => void refreshLedger()}>Refresh</Button></div>
          </div>
          {ledgerError && <p role="alert" className="text-sm text-[var(--red)]">Ledger unavailable: {ledgerError}</p>}
          <PromiseLedger rows={ledger} results={results} />
          <div id="handoff-desk" className="handoff-desk" aria-label="Handoff desk">
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-[var(--ink)]">Handoff desk</h3><Button type="button" variant="secondary" onClick={() => void refreshHandoffs()}>Refresh</Button></div>
            <button type="button" className="sample-line mt-2" onClick={() => { setTranscript('mujhe aapke manager se baat karni hai'); document.getElementById('borrower-turn')?.focus() }}>Trigger sample handoff: “mujhe aapke manager se baat karni hai” <ArrowRight size={14} aria-hidden="true" /></button>
            {handoffError && <p role="alert" className="mt-2 text-sm text-[var(--red)]">Handoffs unavailable: {handoffError}</p>}
            {!handoffs.length && <p className="mt-2 text-sm text-[var(--muted)]">No handoffs yet. Start a comparison, then send the sample line.</p>}
            {handoffs.slice().reverse().map(row => <article key={`${row.session_id}-${row.logged_at}`} className="mt-3 rounded-xl bg-[#fff7e9] p-4"><h4 className="flex items-center gap-2 text-sm font-semibold text-[var(--amber)]"><UserRound size={15} aria-hidden="true" />{row.reason.replaceAll('_', ' ')}</h4><p className="mt-2 break-words whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink)]">{row.brief}</p><p className="mt-2 text-xs text-[var(--muted)]">Session {row.session_id.slice(0, 8)}</p></article>)}
          </div>
        </section>
      </div>

      <section className="panel p-5 sm:p-6" aria-labelledby="fixture-evaluation-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="section-title" id="fixture-evaluation-title">Fixture evaluation</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">Eight synthetic text cases compare supplied naive and layer transcripts. Confirmation is simulated; audio results are reported separately.</p>
          </div>
          <Button type="button" variant="secondary" className="shrink-0" onClick={runEval} disabled={evalBusy}>
            {evalBusy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
            {evalBusy ? 'Evaluating…' : 'Run text eval'}
          </Button>
        </div>
        {evalError && <p role="alert" className="mt-3 text-sm text-[var(--red)]">Evaluation failed: {evalError}</p>}
        {evalResult && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-4 grid gap-3 border-t border-[color:var(--line)] pt-4 sm:grid-cols-2">
            <div className="rounded-xl bg-[#f1f5fc] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Naive slot accuracy</p>
              <p className="mt-1 text-xl font-semibold text-[var(--ink)]">{evalResult.naive_correct}/{evalResult.n} <span className="text-sm font-medium text-[var(--muted)]">({Math.round(evalResult.naive_slot_accuracy * 100)}%)</span></p>
            </div>
            <div className="rounded-xl bg-[#f1f5fc] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Layer slot accuracy</p>
              <p className="mt-1 text-xl font-semibold text-[var(--primary)]">{evalResult.layer_correct}/{evalResult.n} <span className="text-sm font-medium text-[var(--muted)]">({Math.round(evalResult.layer_slot_accuracy * 100)}%)</span></p>
            </div>
            <p className="text-xs leading-relaxed text-[var(--muted)] sm:col-span-2">These results compare different supplied transcripts, so they describe the fixture scenarios rather than measured model uplift.</p>
            <div className="overflow-x-auto sm:col-span-2"><table className="w-full min-w-[450px] text-left text-sm"><caption className="sr-only">Evaluation results by case</caption><thead><tr><th className="py-2">Case</th><th>Naive</th><th>Layer</th></tr></thead><tbody>{evalResult.details?.map(row => <tr key={row.id} className="border-t border-[color:var(--line)]"><td className="py-2">{row.id}: {row.note}</td><td>{row.naive_correct ? 'Pass' : 'Fail'}</td><td>{row.layer_correct ? 'Pass' : 'Fail'}</td></tr>)}</tbody></table></div>
          </motion.div>
        )}
      </section>
    </section>
  );
}
