import type { RunEvent } from '../runs/store.ts';

/**
 * The context a resumed session opens with (restart recovery, a queued Continue): the task, what
 * the user asked for since, and what they queued while it was stopped.
 *
 * Labelled by age on purpose. Restating only the ORIGINAL task under "Current task" told an agent
 * whose instructions had since changed ("research only" → "implement and open a PR") to go back
 * to the first one.
 */

/** How many of the user's later messages are restated; the session itself holds all of them. */
const LATER_SHOWN = 3;
const LATER_CHARS = 4_000;

/** The user's own messages to this task after its opening, oldest first, newest `LATER_SHOWN`.
 *  `automatic` are prefixes of the openings cezar itself sends (a restart, a usage-limit
 *  resume), which are recorded like the user's but are not instructions. */
export function laterInstructions(events: readonly RunEvent[], task: string, automatic: readonly string[]): string[] {
  const later: string[] = [];
  for (const event of events) {
    if (event.type !== 'user-message') continue;
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text || text === task.trim() || automatic.some((prefix) => text.startsWith(prefix))) continue;
    later.push(text.length > LATER_CHARS ? `${text.slice(0, LATER_CHARS)}…` : text);
  }
  return later.slice(-LATER_SHOWN);
}

export function resumeWithContext(opening: string, task: string, later: readonly string[], queued: readonly string[]): string {
  const clean = (parts: readonly string[]) => parts.map((part) => part.trim()).filter((part) => part.length > 0);
  const original = task.trim();
  const since = clean(later);
  const waiting = clean(queued);
  if (since.length === 0 && waiting.length === 0) return original ? `${opening}\n\nThe task:\n\n${original}` : opening;
  const sections = [opening];
  if (original) sections.push(`The task as first given — the later instructions below replace it wherever they differ:\n\n${original}`);
  if (since.length > 0) {
    sections.push(`The user's later instructions, oldest first — the last one is the latest you were following:\n\n${since.join('\n\n---\n\n')}`);
  }
  if (waiting.length > 0) {
    sections.push(`Sent while the task was stopped, oldest first — these are the newest instructions and win over everything above:\n\n${waiting.join('\n\n')}`);
  }
  return sections.join('\n\n');
}
