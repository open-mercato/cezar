import type { RunEvent, RunRecord } from '../runs/store.ts';

/** Keep a backend hand-off useful without turning an old, very long thread into an unbounded
 * opening prompt. The original task and current run state live outside this allowance. */
const CONVERSATION_CONTEXT_CHARS = 60_000;
/** When the handoff journal already says where the task stands, the transcript only has to carry
 *  the most recent exchange. */
const CONVERSATION_WITH_JOURNAL_CHARS = 12_000;
const JOURNAL_CHARS = 8_000;
/** A journal earns the shorter transcript only when it actually says where the task stands:
 *  resume notes, or enough progress to be more than one stray line. */
const JOURNAL_SUBSTANTIVE_CHARS = 400;
/** Cezar's own heartbeat lines (`appendHandoffHeartbeat`) say nothing the task state does not. */
const HEARTBEAT_RE = /^- \S+ — (?:turn complete\b|step "[^"]*" complete\b|picked from \d+ variants$)/;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** The last `max` UTF-16 units, starting at a message boundary and never on half a surrogate pair. */
function keepTail(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let tail = text.slice(-max);
  if (isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
  const firstBoundary = tail.indexOf('\n\n');
  if (firstBoundary >= 0) tail = tail.slice(firstBoundary + 2);
  return { text: tail, truncated: true };
}

/** The first `max` UTF-16 units, ending at a line boundary and never on half a surrogate pair. */
function keepHead(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let head = text.slice(0, max);
  if (isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
  const lastLine = head.lastIndexOf('\n');
  return { text: lastLine > 0 ? head.slice(0, lastLine) : head, truncated: true };
}

function handoffSection(text: string, header: string): string[] {
  const idx = text.indexOf(`${header}\n`);
  if (idx < 0) return [];
  const lines: string[] = [];
  for (const line of text.slice(idx + header.length + 1).split('\n')) {
    if (line.startsWith('## ')) break;
    lines.push(line);
  }
  return lines;
}

/** What the previous session wrote into its handoff journal: its resume notes and its own progress
 *  lines, newest first. Empty when the agent never wrote to it; `substantive` says whether it
 *  carries enough state to justify a shorter transcript. */
export function handoffJournal(handoff: string): { text: string; substantive: boolean } {
  const resumeNotes = handoffSection(handoff, '## Resume notes').join('\n').trim();
  const progress = handoffSection(handoff, '## Progress log')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !HEARTBEAT_RE.test(line));
  const parts = [
    ...(resumeNotes ? ['### Resume notes', resumeNotes] : []),
    ...(progress.length ? ['### Progress log (newest first)', ...progress] : []),
  ];
  if (!parts.length) return { text: '', substantive: false };
  const body = parts.join('\n');
  const substantive = Boolean(resumeNotes) || body.length >= JOURNAL_SUBSTANTIVE_CHARS;
  const { text, truncated } = keepHead(body, JOURNAL_CHARS);
  return { text: truncated ? `${text}\n\n_(journal truncated)_` : text, substantive };
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/^CEZ:(?:PR=\d+|ISSUE=\d+|TITLE=.+)\s*$/gm, '')
    .replace(/\s*CEZ:(?:DONE|MONITORING)\s*$/g, '')
    .replace(/\s*CEZ:ASK[ \t]+\{[\s\S]*\}\s*$/g, '')
    .trim();
  return text || undefined;
}

/**
 * Reconstruct the portable part of a task when a continuation switches runner/account and the
 * provider-owned session id therefore cannot be resumed. Events are already secret-redacted by
 * RunStore; only conversation messages are copied, never tool inputs/results or reasoning. The
 * `handoff` journal is the previous session's own file, read raw and appended as-is.
 */
export function freshContinuationContext(run: RunRecord, events: readonly RunEvent[], handoff = ''): string {
  const v2Messages = events.flatMap((event) => {
    if (event.type !== 'item.completed' || typeof event.item !== 'object' || event.item === null) return [];
    const item = event.item as { kind?: unknown; role?: unknown; text?: unknown };
    // `user-message` is Cezar's authoritative user transcript. Some normalized protocols also
    // echo user messages as items; accepting both would duplicate the instruction at hand-off.
    if (item.kind !== 'message' || item.role === 'user') return [];
    const text = cleanText(item.text);
    if (!text) return [];
    return [{ seq: event.seq, role: 'Assistant', text }];
  });
  // Modern runs persist both v1 and normalized v2 assistant output. Prefer v2 whenever it exists
  // so the new provider does not receive every answer twice; old runs fall back to v1 `text`.
  const assistant = v2Messages.length > 0
    ? v2Messages
    : events.flatMap((event) => {
        if (event.type !== 'text') return [];
        const text = cleanText(event.text);
        return text ? [{ seq: event.seq, role: 'Assistant', text }] : [];
      });
  const user = events.flatMap((event) => {
    if (event.type !== 'user-message') return [];
    const text = cleanText(event.text);
    return text ? [{ seq: event.seq, role: 'User', text }] : [];
  });
  const messages = [...user, ...assistant]
    .sort((a, b) => a.seq - b.seq)
    .map(({ role, text }) => `${role}:\n${text}`);

  const journal = handoffJournal(handoff);
  const { text: conversation, truncated } = keepTail(
    messages.join('\n\n'),
    journal.substantive ? CONVERSATION_WITH_JOURNAL_CHARS : CONVERSATION_CONTEXT_CHARS,
  );

  const steps = run.steps.map((step) =>
    `- ${step.id} (${step.kind}): ${step.status}${step.error ? ` — ${step.error}` : ''}`,
  );
  return [
    'You are continuing an existing Cezar task in a fresh provider session. The previous provider session cannot be resumed. Use this persisted Cezar state and conversation as the hand-off; inspect the existing worktree before changing anything.',
    '',
    '## Original task',
    run.task,
    '',
    '## Cezar task state before this continuation',
    `Status: ${run.status}`,
    ...(run.error ? [`Error: ${run.error}`] : []),
    ...(run.branch ? [`Branch: ${run.branch}`] : []),
    ...(run.worktreePath ? [`Worktree: ${run.worktreePath}`] : []),
    ...(steps.length ? ['Steps:', ...steps] : []),
    '',
    ...(journal.text ? ['## Handoff journal (kept by the previous session)', journal.text, ''] : []),
    `## Conversation history${truncated ? ' (oldest messages truncated)' : ''}`,
    conversation || '(No persisted conversation messages.)',
  ].join('\n');
}
