// Shared display helpers. Handoff transcripts became arrays of
// {speaker, text, timestamp} in v3; older rows and live results are strings.

type TurnLike = { speaker?: unknown; text?: unknown; timestamp?: unknown };

function lineText(item: unknown): string {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    const turn = item as TurnLike;
    if (typeof turn.text === 'string') return turn.text;
  }
  return '';
}

/** Last borrower line of a transcript (string, array of turns, or array of snippets). */
export function transcriptText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const turns = value.filter((item) => lineText(item).trim());
    const borrower = [...turns].reverse().find((item) => {
      const speaker = item && typeof item === 'object' ? String((item as TurnLike).speaker || '').toLowerCase() : '';
      return speaker && speaker !== 'agent' && speaker !== 'bot' && speaker !== 'system';
    });
    return lineText(borrower ?? turns[turns.length - 1]);
  }
  return lineText(value);
}

/** All snippet texts joined, for snippet arrays of strings or {text} objects. */
export function snippetsText(value: unknown, separator = ' · '): string {
  if (!Array.isArray(value)) return transcriptText(value);
  return value.map(lineText).filter(Boolean).join(separator);
}

type AuditLike = { session_id?: string; run_at?: string; audit_status?: string; status?: string };

/** Keep only the newest audit per session (by run_at, later entries win ties). */
export function latestAuditsBySession<T extends AuditLike>(audits: T[]): T[] {
  const bySession = new Map<string, T>();
  const loose: T[] = [];
  for (const audit of audits) {
    if (!audit) continue;
    if (!audit.session_id) { loose.push(audit); continue; }
    const prev = bySession.get(audit.session_id);
    if (!prev || String(audit.run_at || '') >= String(prev.run_at || '')) bySession.set(audit.session_id, audit);
  }
  return [...bySession.values(), ...loose];
}
