import type { RunEvent } from './store.ts';

/**
 * The "previous session" briefing a FRESH agent session is opened on when the old one cannot be
 * resumed.
 *
 * Continue normally means `--resume <sessionId>`: the backend still holds the conversation and the
 * agent wakes up remembering everything. Two ordinary situations have no session id to hand it —
 * the run died before any backend minted one (a crash while queueing for the worktree lock is the
 * common shape), or the user deliberately switched runner/account, which strands the id inside the
 * config dir that created it. Refusing there left the task with nothing but Delete.
 *
 * So the continuation opens a new session instead, and this is what stands in for the memory it
 * doesn't have: the original task, how the last attempt ended, and a bounded replay of the
 * conversation. Delivery-only — it is prepended to the opening prompt, never persisted as the
 * user's own message, because the thread already renders every line of it.
 */

/** What the recap is built from — a run record's identity plus its persisted event log. */
export interface SessionRecapInput {
  /** The run's original task text (`RunRecord.task`) — never an event, so always passed in. */
  task: string;
  /** How the previous attempt ended (`RunRecord.error`), when it ended badly. */
  error?: string;
  /** The run's NDJSON events, oldest first (`RunStore.readEvents`). */
  events: readonly RunEvent[];
}

export interface SessionRecapLimits {
  /** Ceiling for the replayed conversation (the task/error header rides on top). */
  maxChars?: number;
  /** Per-message ceiling, applied before the conversation budget. */
  maxMessageChars?: number;
}

/** Big enough for a real conversation, small enough that it cannot dominate a context window. */
const MAX_RECAP_CHARS = 12_000;
/** One rambling tool-narration turn must not evict the ten turns around it. */
const MAX_MESSAGE_CHARS = 2_000;

interface RecapTurn {
  who: 'user' | 'agent';
  text: string;
}

/**
 * The v1 event types that carry conversation: what the user said (`user-message`) and what the
 * agent said (`text`). Deliberately not the v2 `item.*` stream — it describes tool calls and UI
 * state, which is noise in a briefing, and it is the surface most likely to change shape.
 */
function conversationTurns(events: readonly RunEvent[]): RecapTurn[] {
  const turns: RecapTurn[] = [];
  for (const event of events) {
    const who = event.type === 'user-message' ? 'user' : event.type === 'text' ? 'agent' : undefined;
    if (!who) continue;
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) continue;
    // The engine appends one `text` event per streamed chunk, so a single agent turn arrives as
    // many events. Joining consecutive same-speaker events back together keeps the replay reading
    // like a conversation instead of a shredded one.
    const last = turns[turns.length - 1];
    if (last?.who === who) last.text = `${last.text}\n${text}`;
    else turns.push({ who, text });
  }
  return turns;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/**
 * Render the briefing. Always returns text: even a run that produced no conversation at all still
 * has a task, and that is precisely the case this exists for.
 */
export function buildSessionRecap(input: SessionRecapInput, limits: SessionRecapLimits = {}): string {
  const maxChars = limits.maxChars ?? MAX_RECAP_CHARS;
  const maxMessageChars = limits.maxMessageChars ?? MAX_MESSAGE_CHARS;
  const rendered = conversationTurns(input.events).map(
    (turn) => `[${turn.who}] ${clip(turn.text, maxMessageChars)}`,
  );

  // Drop from the FRONT when over budget: the end of a conversation is where the unfinished work
  // is, and the beginning is the part the task text above already restates.
  let dropped = 0;
  let size = rendered.reduce((total, line) => total + line.length + 2, 0);
  while (dropped < rendered.length && size > maxChars) {
    size -= (rendered[dropped]?.length ?? 0) + 2;
    dropped++;
  }
  const kept = rendered.slice(dropped);

  const sections = [
    '## Previous session (cezar)',
    "This task's previous agent session could not be resumed, so this is a NEW session that does " +
      'not remember any of it. What follows is the record of that session — read it as history, ' +
      'not as something said in this conversation.',
    `**Original task**\n\n${input.task.trim() || '(none recorded)'}`,
  ];
  if (input.error?.trim()) sections.push(`**How the previous session ended:** ${input.error.trim()}`);
  if (kept.length) {
    const omitted =
      dropped > 0 ? `\n\n…${dropped} earlier message${dropped > 1 ? 's' : ''} omitted…` : '';
    sections.push(`**Conversation so far**${omitted}\n\n${kept.join('\n\n')}`);
  } else {
    sections.push(
      '**Conversation so far**\n\nNothing was exchanged — the session ended before the agent ' +
        'produced any output.',
    );
  }
  sections.push(
    'Re-establish context before acting: read the handoff file (CEZ_HANDOFF_FILE) and inspect the ' +
      'working tree for anything this replay does not cover. The message for this new session follows.',
  );
  return sections.join('\n\n');
}
