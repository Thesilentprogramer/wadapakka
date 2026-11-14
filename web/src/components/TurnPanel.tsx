import { AnimatePresence, motion } from 'framer-motion';
import {
  AudioLines,
  ArrowRight,
  AlertCircle,
  Activity,
  Check,
  CircleCheck,
  CircleX,
  CircleStop,
  Clock3,
  ExternalLink,
  FileCheck2,
  FileClock,
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
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from './ui/Button';
import { SpotlightCard } from './ui/SpotlightCard';
import {
  useTurnCall,
  type AdversarialCase,
  type AdversarialCheck,
  type AdversarialEvalResponse,
  type AuditRecord,
  type LedgerRow,
  type Pipeline,
  type PromiseProposal,
  type Slots,
  type TurnEvent,
  type TurnResponse,
  type UnconfirmedProposal,
} from '../hooks/useTurnCall';

const SLOT_FIELDS: Array<{ key: keyof Slots; label: string }> = [
  { key: 'amount_inr', label: 'Amount' },
  { key: 'pay_date', label: 'Payment date' },
  { key: 'mode', label: 'Payment method' },
];

const DECISION_LABELS: Record<string, string> = {
  naive_write: 'Would write (simulated)',
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
      ? 'Simulation only: the parsed fields would be written by the naive path. No Ledger row is created.'
      : 'Simulation only: the naive path shows which fields it would write once amount, date, and payment method are present.';
  }
  if (response?.verdict?.slots?.date_note === 'kal_ambiguous') {
    return '“Kal” can mean yesterday or tomorrow. Ask for an exact date before continuing.';
  }
  if (decision === 'readback') return 'Nothing is written until the borrower confirms all three details.';
  if (decision === 'confirmed_write') return 'The server reports a commit attempt. Check commit status and the guarded Ledger row below.';
  if (decision === 'handoff') return 'Automation stopped. Use the handoff brief to continue with a person.';
  return 'Critical details stay pending until the spoken read back is confirmed.';
}

function proposalOf(response?: TurnResponse): PromiseProposal | undefined {
  return response?.proposal || response?.session?.proposal || undefined;
}

function proposalId(proposal?: PromiseProposal) {
  const id = proposal?.id || proposal?.proposal_id;
  return typeof id === 'string' ? id : '';
}

function rowAmount(row: LedgerRow) {
  const amount = row.amount_inr ?? (row.amount_paise === undefined ? undefined : row.amount_paise / 100);
  return amount === undefined ? '—' : `₹${Number(amount).toLocaleString('en-IN')}`;
}

function auditStatusOf(audit?: AuditRecord | null) {
  return String(audit?.audit_status || audit?.status || '—').replaceAll('_', ' ');
}

function discrepancyText(audit?: AuditRecord | null): string {
  if (!audit) return 'No audit discrepancy supplied.';
  if (typeof audit.discrepancy === 'string' && audit.discrepancy.trim()) return audit.discrepancy;
  if (audit.discrepancy && typeof audit.discrepancy === 'object') return JSON.stringify(audit.discrepancy);
  const diffs: Array<Record<string, unknown>> = Array.isArray(audit.field_diffs)
    ? audit.field_diffs
    : Object.entries(audit.field_diffs || {}).map(([field, value]) => ({ field, value }));
  if (diffs.length) return diffs.map((diff) => {
    const field = String(diff.field || diff.name || 'field');
    const said = diff.said ?? diff.transcript ?? diff.parsed ?? diff.expected;
    const saved = diff.saved ?? diff.ledger ?? diff.actual ?? diff.observed;
    return `${field}: said ${String(said ?? '—')}, saved ${String(saved ?? '—')}`;
  }).join(' · ');
  return Array.isArray(audit.reasons) && audit.reasons.length ? audit.reasons.join(' · ') : 'No discrepancy supplied.';
}

function proposalSummary(proposal?: PromiseProposal) {
  if (!proposal) return 'Proposal fields unavailable';
  const amount = proposal.amount_inr ?? (proposal.amount_paise === undefined ? undefined : proposal.amount_paise / 100);
  return [amount === undefined ? null : `₹${Number(amount).toLocaleString('en-IN')}`, proposal.pay_date, proposal.mode]
    .filter(Boolean).join(' · ') || 'Proposal fields unavailable';
}

function checkValue(value: boolean | AdversarialCheck | undefined): boolean | null {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') return null;
  const result = value.passed ?? value.pass ?? value.ok;
  return typeof result === 'boolean' ? result : null;
}

const ADVERSARIAL_METRICS: Array<{ key: string; aliases: string[]; label: string }> = [
  { key: 'exact_promise_fields', aliases: ['exact_promise_fields', 'exact_fields', 'promise_fields_exact'], label: 'Exact promise fields' },
  { key: 'zero_writes_without_valid_confirmation', aliases: ['zero_writes_without_valid_confirmation', 'no_unconfirmed_writes', 'zero_unconfirmed_writes', 'no_write_without_confirmation'], label: 'No write without valid confirmation' },
  { key: 'hardship_wrong_person_handoff', aliases: ['hardship_wrong_person_handoff', 'safety_handoff', 'handoff_hardship_wrong_person', 'correct_safety_handoff'], label: 'Hardship / wrong-person handoff' },
  { key: 'zero_false_refusal_valid_promise', aliases: ['zero_false_refusal_valid_promise', 'no_false_refusal', 'valid_promise_not_refused'], label: 'No false refusal of valid promise' },
];

function readCounter(value: unknown, denominator: number): { numerator: number; denominator: number } | null {
  if (typeof value === 'number') return { numerator: Math.round(value * (value <= 1 ? denominator : 1)), denominator: value <= 1 ? denominator : Math.max(denominator, value) };
  if (!value || typeof value !== 'object') return null;
  const metric = value as Record<string, unknown>;
  const total = Number(metric.denominator ?? metric.total ?? metric.n ?? denominator);
  const numerator = Number(metric.numerator ?? metric.passed_count ?? (typeof metric.passed === 'number' ? metric.passed : undefined));
  if (Number.isFinite(numerator) && Number.isFinite(total)) return { numerator, denominator: total };
  if (typeof metric.passed === 'boolean' || typeof metric.pass === 'boolean' || typeof metric.ok === 'boolean') {
    return { numerator: Number(metric.passed ?? metric.pass ?? metric.ok), denominator: 1 };
  }
  return null;
}

function caseMetricCount(cases: AdversarialCase[], aliases: string[]) {
  let numerator = 0;
  let denominator = 0;
  for (const row of cases) {
    const checks = row.checks || {};
    const key = aliases.find((alias) => alias in checks);
    if (!key) continue;
    const passed = checkValue(checks[key]);
    if (passed === null) continue;
    denominator++;
    if (passed) numerator++;
  }
  return denominator ? { numerator, denominator } : null;
}

function adversarialCases(result: AdversarialEvalResponse | null): AdversarialCase[] {
  const rows = result?.cases || result?.personas || result?.results || [];
  return Array.isArray(rows) ? rows : [];
}

function metricCount(result: AdversarialEvalResponse, cases: AdversarialCase[], aliases: string[]) {
  const metricSource = result.metrics || result.aggregates || {};
  const apiMetric = aliases.map((alias) => metricSource[alias]).find((value) => value !== undefined)
    ?? aliases.map((alias) => result[alias]).find((value) => value !== undefined);
  return readCounter(apiMetric, cases.length) || caseMetricCount(cases, aliases) || { numerator: 0, denominator: cases.length };
}

function stateName(value: unknown, fallback = '—') {
  if (typeof value === 'string' && value) return value.replaceAll('_', ' ');
  if (value && typeof value === 'object') {
    const state = (value as Record<string, unknown>).state;
    if (typeof state === 'string') return state.replaceAll('_', ' ');
  }
  return fallback;
}

function expectedStateName(value: unknown) {
  if (typeof value === 'string') return stateName(value);
  if (!value || typeof value !== 'object') return '—';
  const expected = value as Record<string, unknown>;
  if (typeof expected.state === 'string') return stateName(expected.state);
  if (typeof expected.handoff_reason === 'string' && expected.handoff_reason) return `HANDOFF · ${expected.handoff_reason.replaceAll('_', ' ')}`;
  if (expected.valid_promise === true) return 'WRITTEN · valid promise';
  if (Array.isArray(expected.rows) && expected.rows.length) return `WRITTEN · ${expected.rows.length} row${expected.rows.length === 1 ? '' : 's'}`;
  if (Array.isArray(expected.rows) && expected.rows.length === 0) return 'No Ledger write expected';
  return '—';
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
            <p className="mt-1 text-sm text-[var(--muted)]">{isLayer ? 'Normalize · read back · confirm · guarded commit' : 'Comparison only · shows what it would write'}</p>
          </div>
        </div>
        <span className="pill shrink-0 text-[10px] font-bold tracking-[0.08em]">
          {isLayer ? 'GUARDED COMMIT' : 'SIMULATED · WOULD WRITE'}
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

          {isLayer && (response?.commit_status || response?.audit_status || response?.evidence_id) && (
            <dl className="mt-3 grid gap-2 rounded-xl bg-[#f5f7fb] p-3 text-xs sm:grid-cols-3">
              <div><dt className="font-semibold text-[var(--muted)]">Commit status</dt><dd className="mt-1 break-words font-medium text-[var(--ink)]">{response.commit_status || 'pending'}</dd></div>
              <div><dt className="font-semibold text-[var(--muted)]">Audit status</dt><dd className="mt-1 break-words font-medium text-[var(--ink)]">{response.audit_status || 'pending'}</dd></div>
              <div><dt className="font-semibold text-[var(--muted)]">Evidence</dt><dd className="mt-1 break-all font-medium text-[var(--ink)]">{response.evidence_id || '—'}</dd></div>
            </dl>
          )}

          {isLayer && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" variant="primary" onClick={() => onConfirm(true)} disabled={!canConfirm || busy}>
                <Check size={15} aria-hidden="true" /> Confirm read back · typed demo
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

function PromiseLedger({ rows }: { rows: LedgerRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[690px] border-collapse text-left text-sm">
        <caption className="sr-only">Actual promises recorded by the guarded Ledger</caption>
        <thead>
          <tr className="border-b border-[color:var(--line)] text-xs text-[var(--muted)]">
            <th scope="col" className="px-2 py-3 font-semibold">Amount</th>
            <th scope="col" className="px-2 py-3 font-semibold">Date</th>
            <th scope="col" className="px-2 py-3 font-semibold">Method</th>
            <th scope="col" className="px-2 py-3 font-semibold">Status</th>
            <th scope="col" className="px-2 py-3 font-semibold">Confirmed via</th>
            <th scope="col" className="px-2 py-3 font-semibold">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={6} className="px-2 py-5 text-sm text-[var(--muted)]">No guarded promises have been committed yet. Simulated comparison results never appear here.</td></tr>
          ) : rows.map((row, index) => {
            const promiseId = row.promise_id;
            const evidenceId = row.confirmation_evidence_id || row.evidence_id;
            const evidenceHref = promiseId ? `/api/ledger/${encodeURIComponent(promiseId)}/evidence` : undefined;
            return (
              <tr key={promiseId || row.commit_key || `${row.session_id || 'row'}-${index}`} className="border-b border-[color:var(--line)] last:border-0">
                <td className="px-2 py-3 font-semibold">{rowAmount(row)}</td>
                <td className="px-2 py-3">{row.pay_date || '—'}</td>
                <td className="px-2 py-3">{row.mode || '—'}</td>
                <td className="px-2 py-3"><span className="pill !px-2 !py-1 !text-[9px]">{String(row.status || 'OPEN').replaceAll('_', ' ')}</span></td>
                <td className="px-2 py-3">{String(row.confirmation_source || row.source || '—').replaceAll('_', ' ')}</td>
                <td className="px-2 py-3">
                  {evidenceHref ? (
                    <a className="inline-flex items-center gap-1.5 font-semibold text-[var(--primary)] underline-offset-2 hover:underline" href={evidenceHref} target="_blank" rel="noreferrer" title={evidenceId ? `Evidence ${evidenceId}` : 'Open confirmation transcript evidence'}>
                      <ExternalLink size={13} aria-hidden="true" /> {evidenceId ? `Evidence ${evidenceId.slice(0, 8)}` : 'Open evidence'}
                    </a>
                  ) : <span className="text-[var(--muted)]">{evidenceId ? `ID ${evidenceId}` : 'Unavailable'}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProposalQueue({ results, audits, sessionAudits, ledger, unconfirmed }: {
  results: Partial<Record<Pipeline, TurnResponse>>;
  audits: AuditRecord[];
  sessionAudits: Record<string, AuditRecord>;
  ledger: LedgerRow[];
  unconfirmed: UnconfirmedProposal[];
}) {
  const candidates: Array<{ sessionId: string; proposal: PromiseProposal; status: string; audit?: AuditRecord }> = [];
  const add = (sessionId: string, proposal?: PromiseProposal | null, status?: string, audit?: AuditRecord) => {
    if (!proposal) return;
    const id = proposalId(proposal);
    const alreadyCommitted = ledger.some((row) => (id && row.proposal_id === id)
      || (row.session_id === sessionId && proposal.amount_inr !== undefined
        && Number(row.amount_inr ?? (row.amount_paise === undefined ? NaN : row.amount_paise / 100)) === Number(proposal.amount_inr ?? (proposal.amount_paise === undefined ? NaN : proposal.amount_paise / 100))
        && row.pay_date === proposal.pay_date && String(row.mode || '').toLowerCase() === String(proposal.mode || '').toLowerCase()));
    if (alreadyCommitted) return;
    const key = `${sessionId}:${id || proposal.version || 'proposal'}`;
    if (candidates.some((item) => `${item.sessionId}:${proposalId(item.proposal) || item.proposal.version || 'proposal'}` === key)) return;
    candidates.push({ sessionId, proposal, status: status || proposal.status || 'UNCONFIRMED', audit });
  };

  const layer = results.layer;
  if (layer) add(layer.session.id, proposalOf(layer), layer.commit_status || layer.session.state, layer.audit || sessionAudits[layer.session.id]);
  for (const item of unconfirmed) add(item.session_id, item.proposal, item.audit_status || 'UNCONFIRMED', sessionAudits[item.session_id] || audits.find((audit) => audit.session_id === item.session_id));
  for (const audit of [...audits, ...Object.values(sessionAudits)]) {
    const snapshot = audit.proposal_snapshot || (audit.proposal && typeof audit.proposal === 'object' ? audit.proposal as PromiseProposal : null);
    if (audit.session_id) add(audit.session_id, snapshot, audit.audit_status || audit.status || 'UNCONFIRMED', audit);
  }

  return (
    <section className="mt-5 border-t border-[color:var(--line)] pt-4" aria-labelledby="unconfirmed-proposals-title">
      <div className="mb-2 flex items-center gap-2">
        <FileClock size={16} className="text-[var(--amber)]" aria-hidden="true" />
        <h3 id="unconfirmed-proposals-title" className="text-sm font-semibold text-[var(--ink)]">Unconfirmed proposal queue</h3>
        <span className="pill !px-2 !py-1 !text-[9px]">{candidates.length}</span>
      </div>
      {!candidates.length ? (
        <p className="text-sm text-[var(--muted)]">Pending proposals appear here until a verified guarded commit exists.</p>
      ) : (
        <ul className="space-y-2">
          {candidates.map(({ sessionId, proposal, status, audit }, index) => (
            <li key={`${sessionId}-${proposalId(proposal) || index}`} className="rounded-xl bg-[#fff8ea] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm text-[var(--ink)]">{proposalSummary(proposal)}</strong>
                <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase text-[var(--amber)]">{String(status).replaceAll('_', ' ')}</span>
              </div>
              <p className="mb-0 mt-1 text-xs text-[var(--muted)]">Session {sessionId.slice(0, 8)} · read back {String(proposal.readback_status || 'not verified').replaceAll('_', ' ')} · audit {auditStatusOf(audit)}</p>
              {audit && auditStatusOf(audit).toLowerCase().includes('review') && <p className="mb-0 mt-1 text-xs text-[var(--amber)]">{discrepancyText(audit)}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdversarialEvaluation({ result, busy, error, onRun }: {
  result: AdversarialEvalResponse | null;
  busy: boolean;
  error: string;
  onRun: () => void;
}) {
  const cases = adversarialCases(result);
  const rawVariants = result?.negative_variants;
  const negativeVariants: Array<Record<string, unknown> | string> = Array.isArray(rawVariants)
    ? rawVariants as Array<Record<string, unknown> | string>
    : rawVariants && typeof rawVariants === 'object'
      ? Object.entries(rawVariants).map(([name, value]) => typeof value === 'object' && value ? { name, ...(value as Record<string, unknown>) } : { name, result: value })
      : [];
  return (
    <section className="panel p-5 sm:p-6" aria-labelledby="adversarial-evaluation-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="section-title" id="adversarial-evaluation-title">Adversarial conversations</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">Eight isolated synthetic text conversations exercise state changes and guarded commits. Confirmations use a labeled typed demo acknowledgement; optional live audio smoke is separate.</p>
        </div>
        <Button type="button" variant="secondary" className="shrink-0" onClick={onRun} disabled={busy}>
          {busy ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> : <ActivityIcon />}
          {busy ? 'Running conversations…' : 'Run adversarial eval'}
        </Button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--red)]">Adversarial evaluation failed: {error}</p>}
      {result && (
        <div className="mt-4 border-t border-[color:var(--line)] pt-4">
          {result.passed !== undefined && <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-[#edf7f0] px-3 py-1.5 text-xs font-semibold text-[var(--green)]"><CircleCheck size={14} aria-hidden="true" />Overall result: {typeof result.passed === 'boolean' ? result.passed ? 'passed' : 'needs review' : `${result.passed} passed`}</p>}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {ADVERSARIAL_METRICS.map(({ key, aliases, label }) => {
              const count = metricCount(result, cases, aliases);
              return <div key={key} className="rounded-xl bg-[#f3f6fb] px-3 py-3">
                <span className="block text-xs font-medium text-[var(--muted)]">{label}</span>
                <strong className="mt-1 block text-lg tabular-nums text-[var(--ink)]">{count.numerator}/{count.denominator}</strong>
              </div>;
            })}
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-xs">
              <caption className="sr-only">Adversarial persona results and checks</caption>
              <thead><tr><th className="py-2">Persona</th><th>Expected → observed</th><th>Checks</th><th>Rows</th><th>Failing turn</th><th>Audit</th></tr></thead>
              <tbody>
                {cases.map((row, index) => {
                  const checks = row.checks || {};
                  const checkEntries = ADVERSARIAL_METRICS.map(({ key, aliases, label }) => {
                    const checkKey = aliases.find((alias) => alias in checks);
                    const value = checkKey ? checkValue(checks[checkKey]) : null;
                    return { key, label, value };
                  });
                  const caseId = row.case_id || row.id || row.persona || '';
                  const transitions = row.observed_transitions || row.transitions || (row.turns || []).map((turn) => ({ turn: turn.name, state: turn.observed_state, status: turn.commit_status, rows: turn.row_count }));
                  return (
                    <tr key={row.id || row.persona || index} className="border-t border-[color:var(--line)] align-top">
                      <td className="py-2 font-semibold capitalize">{row.persona || row.name || row.id || `Case ${index + 1}`}</td>
                      <td className="py-2"><span className="block">{expectedStateName(row.expected_state || row.expected)}</span><span className="text-[var(--muted)]">→ {stateName(row.observed_state || row.final_state || row.observed)}</span></td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1" title={checkEntries.map((check) => `${check.label}: ${check.value === null ? 'not reported' : check.value ? 'pass' : 'fail'}`).join('\n')}>
                          {checkEntries.map((check) => <span key={check.key} className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${check.value === true ? 'bg-[#e7f6ed] text-[var(--green)]' : check.value === false ? 'bg-[#fff0f0] text-[var(--red)]' : 'bg-[#edf1f7] text-[var(--muted)]'}`} aria-label={`${check.label}: ${check.value === null ? 'not reported' : check.value ? 'pass' : 'fail'}`}>
                            {check.value === true ? <CircleCheck size={12} /> : check.value === false ? <CircleX size={12} /> : <AlertCircle size={12} />}{check.label.split(' ')[0]}
                          </span>)}
                        </div>
                        {!!transitions.length && <details className="mt-1"><summary className="cursor-pointer text-[var(--primary)]">Observed transitions</summary><p className="mt-1 max-w-sm whitespace-pre-wrap text-[var(--muted)]">{transitions.map((transition) => typeof transition === 'string' ? transition : JSON.stringify(transition)).join(' → ')}</p></details>}
                        {Array.isArray(row.errors) && row.errors.length > 0 && <p className="mt-1 text-[var(--red)]">{row.errors.join(' · ')}</p>}
                      </td>
                      <td className="py-2 tabular-nums">{row.row_count ?? (row.observed && typeof row.observed === 'object' ? (row.observed as Record<string, unknown>).row_count as number | undefined : undefined) ?? '—'}</td>
                      <td className="py-2">{row.failing_turn ?? row.failed_turn ?? '—'}</td>
                      <td className="py-2">{caseId ? <a href={`/api/eval/adversarial/${encodeURIComponent(caseId)}/audit`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-[var(--primary)] underline-offset-2 hover:underline">Open audit <ExternalLink size={12} /></a> : row.audit_id ? <span className="font-mono">{row.audit_id}</span> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!!negativeVariants.length && <details className="mt-3 rounded-xl bg-[#f7f9fd] p-3"><summary className="cursor-pointer text-xs font-semibold text-[var(--primary)]">Negative variants · {negativeVariants.length}</summary><ul className="mt-2 space-y-2">{negativeVariants.map((variant, index) => { const item: Record<string, unknown> = typeof variant === 'string' ? { name: variant } : variant; const passed = checkValue((item.passed ?? item.pass ?? item.ok ?? item.check) as boolean | AdversarialCheck | undefined); return <li key={String(item.id || item.name || index)} className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--line)] pt-2 text-xs"><span className="min-w-0 break-words">{String(item.name || item.id || item.variant || `Variant ${index + 1}`)}{item.error ? ` · ${String(item.error)}` : ''}</span><span className={passed === true ? 'font-semibold text-[var(--green)]' : passed === false ? 'font-semibold text-[var(--red)]' : 'text-[var(--muted)]'}>{passed === null ? String(item.status || 'reported') : passed ? 'Pass' : 'Fail'}</span></li>; })}</ul></details>}
          {!cases.length && <p className="mt-3 text-sm text-[var(--muted)]">Evaluation returned no persona cases.</p>}
        </div>
      )}
    </section>
  );
}

function ActivityIcon() {
  return <Activity size={15} aria-hidden="true" />;
}

function PromiseTimeline({ refreshKey, onFollowup }: { refreshKey: string; onFollowup: () => void }) {
  const [history, setHistory] = useState<Array<LedgerRow & { outcomes?: Array<{ outcome: string; occurred_at: string; linked_promise_id?: string }> }>>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/accounts/synthetic-ravi-kumar/promises').then(async response => {
      if (!response.ok) throw new Error('Promise history is unavailable.');
      return response.json() as Promise<{ rows: typeof history }>;
    }).then(data => { if (active) { setHistory(data.rows); setError(''); } })
      .catch(() => { if (active) setError('Promise history is unavailable.'); });
    return () => { active = false; };
  }, [refreshKey]);
  return <section className="mt-5 border-t border-[color:var(--line)] pt-4" aria-label="Promise timeline">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Promise timeline</h3><Button type="button" variant="secondary" onClick={onFollowup}>Start follow-up call</Button></div>
    <p className="mt-1 text-xs text-[var(--muted)]">Synthetic account · outcomes use recorded demo payments and the server clock.</p>
    {error && <p role="alert" className="text-xs text-[var(--red)]">{error}</p>}
    {!history.length && !error && <p className="mt-3 text-sm text-[var(--muted)]">No confirmed promise yet.</p>}
    <ol className="mt-3 space-y-3">{history.map(row => <li key={row.promise_id} className="rounded-xl bg-[var(--panel-soft)] p-3 text-sm">
      <strong>Made</strong> · ₹{Number(row.amount_inr || 0).toLocaleString('en-IN')} by {row.pay_date} · {row.mode}
      <span className="ml-2 rounded-full bg-white px-2 py-1 text-xs font-semibold capitalize text-[var(--primary)]">{row.status}</span>
      {row.outcomes?.map(event => <p key={`${event.outcome}-${event.occurred_at}`} className="mb-0 mt-2 text-xs text-[var(--muted)]">→ {event.outcome}{event.linked_promise_id ? ` · linked to ${event.linked_promise_id.slice(0, 8)}` : ''} · {event.occurred_at}</p>)}
    </li>)}</ol>
  </section>;
}

function HandoffDesk({ handoffs, handoffError, audits, sessionAudits, auditError, ledger, onRefreshHandoffs, onRefreshAudits, onUseSample }: {
  handoffs: ReturnType<typeof useTurnCall>['handoffs'];
  handoffError: string;
  audits: AuditRecord[];
  sessionAudits: Record<string, AuditRecord>;
  auditError: string;
  ledger: LedgerRow[];
  onRefreshHandoffs: () => void;
  onRefreshAudits: () => void;
  onUseSample: () => void;
}) {
  const [actionCase, setActionCase] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  async function changeCase(id: string, action: 'takeover' | 'resolve') {
    setActionCase(id);
    setActionError('');
    try {
      const response = await fetch(`/api/handoffs/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not update this case. Refresh and try again.');
      onRefreshHandoffs();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update this case.');
    } finally {
      setActionCase(null);
    }
  }
  const auditRows = [...audits, ...Object.values(sessionAudits)];
  const latestAudit = (sessionId: string) => sessionAudits[sessionId] || auditRows.find((audit) => audit.session_id === sessionId);
  const needsReview = auditRows.filter((audit, index, all) => {
    const status = auditStatusOf(audit).toLowerCase();
    return (status.includes('review') || status.includes('discrep') || status.includes('unconfirmed'))
      && all.findIndex((item) => (item.audit_id && item.audit_id === audit.audit_id) || (!item.audit_id && item.session_id === audit.session_id)) === index;
  });

  return (
    <div id="handoff-desk" className="handoff-desk" aria-label="Handoff desk">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]">Handoff desk</h3>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onRefreshHandoffs}>Refresh handoffs</Button>
          <Button type="button" variant="secondary" onClick={onRefreshAudits}>Refresh audits</Button>
        </div>
      </div>
      <button type="button" className="sample-line mt-2" onClick={onUseSample}>Trigger sample handoff: “mujhe aapke manager se baat karni hai” <ArrowRight size={14} aria-hidden="true" /></button>
      {handoffError && <p role="alert" className="mt-2 text-sm text-[var(--red)]">Handoffs unavailable: {handoffError}</p>}
      {actionError && <p role="alert" className="mt-2 text-sm text-[var(--red)]">{actionError}</p>}
      {!handoffs.length && <p className="mt-2 text-sm text-[var(--muted)]">No handoffs yet. A reason, relevant transcript, and audit discrepancy will appear when a case needs a person.</p>}
      <div className="space-y-3">
        {handoffs.filter(row => !row.legacy).slice().reverse().map((row) => {
          const audit = row.audit || latestAudit(row.session_id);
          const transcript = typeof row.transcript === 'string' ? row.transcript : row.transcript_snippets?.join(' · ') || (Array.isArray(audit?.transcript_snippets) ? audit?.transcript_snippets.join(' · ') : '');
          const candidates = row.unresolved_slot_candidates || audit?.parsed_candidates;
          const safetyCase = ['hardship', 'wrong_person', 'dispute'].some((reason) => row.reason.toLowerCase().includes(reason));
          const hasRows = ledger.some((item) => item.session_id === row.session_id);
          const status = auditStatusOf(audit);
          return (
            <article key={row.id || `${row.session_id}-${row.logged_at}`} className="mt-3 rounded-xl bg-[#fff7e9] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="flex items-center gap-2 text-sm font-semibold capitalize text-[var(--amber)]"><UserRound size={15} aria-hidden="true" />{row.reason.replaceAll('_', ' ')}</h4>
                <span className="rounded-full bg-white px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-[var(--amber)]">{row.status || status}</span>
                {safetyCase && !hasRows && <span className="rounded-full bg-[#e7f6ed] px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-[var(--green)]">0 Ledger writes</span>}
              </div>
              <p className="mt-2 break-words whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink)]">{row.brief || 'Review the transcript and resolve the open issue.'}</p>
              {row.reason_evidence && <p className="mt-2 rounded-lg bg-[#fff0cb] px-3 py-2 text-sm font-semibold leading-relaxed text-[var(--ink)]"><span className="block text-[10px] uppercase tracking-wide text-[var(--amber)]">Reason evidence</span>{row.reason_evidence}</p>}
              {Array.isArray(row.transcript) && <details className="mt-3 text-xs text-[var(--ink)]"><summary className="cursor-pointer font-semibold">Full transcript · {row.transcript.length} turns</summary><ol className="mt-2 space-y-2">{row.transcript.map((turn, index) => <li key={index} className="rounded-lg bg-white p-2"><strong className="capitalize">{turn.speaker}</strong> <time className="text-[var(--muted)]">{turn.timestamp}</time><p className="mb-0 mt-1">{turn.text}</p></li>)}</ol></details>}
              {transcript && <p className="mb-0 mt-2 border-t border-[#f0dfbe] pt-2 text-xs leading-relaxed text-[var(--muted)]"><strong className="text-[var(--ink)]">Last relevant transcript:</strong> “{transcript}”</p>}
              {candidates && <p className="mb-0 mt-2 break-words text-xs text-[var(--muted)]"><strong className="text-[var(--ink)]">Unresolved slot candidates:</strong> {typeof candidates === 'string' ? candidates : JSON.stringify(candidates)}</p>}
              <p className="mb-0 mt-2 text-xs text-[var(--muted)]"><strong className="text-[var(--ink)]">Read-back:</strong> {row.readback_status || audit?.proposal_snapshot?.readback_status || 'not supplied'} · <strong className="text-[var(--ink)]">Audit discrepancy:</strong> {discrepancyText(audit)}</p>
              <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                <span>Session {row.session_id.slice(0, 8)} · {row.logged_at || row.taken_over_at || ''}</span>
                <a className="inline-flex shrink-0 items-center gap-1 font-semibold text-[var(--primary)] underline-offset-2 hover:underline" href={`/api/session/${encodeURIComponent(row.session_id)}/audit`} target="_blank" rel="noreferrer">Open audit <ExternalLink size={12} /></a>
              </div>
              {row.id && <div className="mt-3 flex items-center gap-2">{row.status === 'open' && <Button type="button" variant="primary" disabled={actionCase === row.id} onClick={() => void changeCase(row.id!, 'takeover')}>Take over</Button>}{row.status === 'taken_over' && <Button type="button" variant="secondary" disabled={actionCase === row.id} onClick={() => void changeCase(row.id!, 'resolve')}>Resolve case</Button>}{row.taken_over_by && <span className="text-xs text-[var(--muted)]">Owned by {row.taken_over_by}</span>}</div>}
            </article>
          );
        })}
      </div>
      <section className="mt-5 border-t border-[color:var(--line)] pt-4" aria-labelledby="audit-review-title">
        <div className="flex items-center gap-2"><AlertCircle size={15} className="text-[var(--amber)]" aria-hidden="true" /><h4 id="audit-review-title" className="text-sm font-semibold text-[var(--ink)]">Said vs saved review</h4></div>
        {auditError && <p role="status" className="mt-2 text-xs text-[var(--red)]">{auditError}</p>}
        {!needsReview.length ? <p className="mt-2 text-sm text-[var(--muted)]">No unresolved audit discrepancy is reported.</p> : needsReview.map((audit, index) => <article key={audit.audit_id || audit.session_id || index} className="mt-2 rounded-xl bg-[#fff4e1] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-xs font-semibold text-[var(--ink)]">{audit.session_id ? `Session ${audit.session_id.slice(0, 8)}` : audit.audit_id || 'Audit review'}</strong><span className="rounded-full bg-white px-2 py-1 text-[9px] font-bold uppercase text-[var(--amber)]">{statusName(audit)}</span></div>
          <p className="mb-0 mt-2 break-words text-xs leading-relaxed text-[var(--ink)]">{discrepancyText(audit)}</p>
          {audit.session_id && <a className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[var(--primary)] underline-offset-2 hover:underline" href={`/api/session/${encodeURIComponent(audit.session_id)}/audit`} target="_blank" rel="noreferrer">Open source audit <ExternalLink size={12} /></a>}
        </article>)}
      </section>
    </div>
  );
}

function statusName(audit: AuditRecord) {
  return auditStatusOf(audit);
}

export default function TurnPanel({ active = true }: { active?: boolean }) {
  const [transcript, setTranscript] = useState('');
  const {
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
    canTurn,
    canConfirm,
    startComparison,
    submitText,
    toggleRecording,
    confirm,
    toggleReadback,
    seekReadback,
    runEval,
    runAdversarialEval,
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
              <p className="mt-1 text-sm text-[var(--muted)]">Actual guarded commits only; simulated writes stay out of this Ledger.</p>
            </div>
            <div className="flex items-center gap-2"><span className="pill inline-flex items-center gap-2"><FileCheck2 size={13} aria-hidden="true" />{ledger.length} {ledger.length === 1 ? 'write' : 'writes'}</span><Button type="button" variant="secondary" onClick={() => void refreshLedger()}>Refresh</Button></div>
          </div>
          {ledgerError && <p role="alert" className="text-sm text-[var(--red)]">Ledger unavailable: {ledgerError}</p>}
          <PromiseLedger rows={ledger} />
          <PromiseTimeline refreshKey={ledger.map(row => `${row.promise_id}:${row.status}`).join('|')} onFollowup={() => void startComparison()} />
          <ProposalQueue results={results} audits={audits} sessionAudits={sessionAudits} ledger={ledger} unconfirmed={unconfirmedProposals} />
          <HandoffDesk
            handoffs={handoffs}
            handoffError={handoffError}
            audits={audits}
            sessionAudits={sessionAudits}
            auditError={auditError}
            ledger={ledger}
            onRefreshHandoffs={() => void refreshHandoffs()}
            onRefreshAudits={() => void refreshAudits(results.layer ? [results.layer.session.id] : [])}
            onUseSample={() => { setTranscript('mujhe aapke manager se baat karni hai'); document.getElementById('borrower-turn')?.focus() }}
          />
        </section>
      </div>

      <section className="panel p-5 sm:p-6" aria-labelledby="fixture-evaluation-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="section-title" id="fixture-evaluation-title">Legacy parser fixtures</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">Legacy single-turn parser fixtures only. They compare supplied transcripts and do not replay conversations or write to the Ledger.</p>
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

      <AdversarialEvaluation result={adversarialResult} busy={adversarialBusy} error={adversarialError} onRun={() => void runAdversarialEval()} />
    </section>
  );
}
