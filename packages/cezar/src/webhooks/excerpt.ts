import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { WEBHOOK_AGENT_EXCERPT_LIMIT } from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { receiverSecretValues, type PrivateReceiver } from './endpoints.ts';
import { scrubWebhookText } from './privacy.ts';

// The parked turn's last message sits at the end of the run's NDJSON; never read a whole transcript.
const TAIL_BYTES = 512 * 1024;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The agent's own words in one persisted event, matching the store's trust boundary. */
function agentText(event: Record<string, unknown>): string | undefined {
  const item = event.item as Record<string, unknown> | undefined;
  if (event.type === 'item.completed' && item?.kind === 'message' && item.role === 'assistant' && typeof item.text === 'string') return item.text;
  if (event.type === 'text' && typeof event.text === 'string') return event.text;
  return undefined;
}

/** Last assistant text of the turn that parked at `until`, or undefined. Never throws.
 *  `boundary: 'message'` reads a finished run's final reply: a later check step does not hide it, a user message does. */
export async function readLastAgentText(dataDir: string, runId: string, until: string, options: { boundary?: 'turn' | 'message' } = {}): Promise<string | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  const limit = Date.parse(until);
  try {
    const file = await open(join(dataDir, 'runs', `${runId}.ndjson`), 'r');
    let raw: string;
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - TAIL_BYTES), buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      raw = buffer.subarray(0, bytesRead).toString('utf8');
      // A tail read starts mid-line; drop the partial first line.
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } finally { await file.close(); }
    const lines = raw.split('\n');
    let sawTurnEnd = false;
    for (let index = lines.length - 1; index >= 0; index--) {
      let event: Record<string, unknown>;
      try { event = JSON.parse(lines[index]!) as Record<string, unknown>; } catch { continue; }
      if (!event || typeof event !== 'object') continue;
      if (typeof event.ts === 'string' && Date.parse(event.ts) > limit) continue;
      if (event.type === 'user-message') return undefined;
      if (options.boundary !== 'message') {
        // Nudges can start another backend turn without a user message or a new step.
        if (event.type === 'step-start' || event.type === 'turn.started') return undefined;
        // Legacy v1 has no turn-start event. Skip the parked turn's own end, but
        // never cross the preceding turn's end to borrow its question. Do not count
        // v2 turn.completed too: mixed transcripts persist both completion events.
        if (event.type === 'turn-end') {
          if (sawTurnEnd) return undefined;
          sawTurnEnd = true;
        }
      }
      const text = agentText(event)?.trim();
      if (text) return text;
    }
  } catch { /* Missing or unreadable history: no excerpt, never a failed delivery. */ }
  return undefined;
}

// Markers are cezar's protocol, not the agent's words. Redact complete values before
// bounding, so a clipped secret can never escape exact matching.
function scrubAgentText(text: string, secrets: readonly string[], redact: (text: string) => string): string {
  const stripped = text.split('\n').filter(line => !/^\s*CEZ:[A-Z_]+/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return scrubWebhookText(redactSecrets(redact(stripped), [...collectSecretValues(), ...secrets])).trim();
}

/** A finished task's reply, kept from its START (the answer leads); ends with `…` when shortened. */
export function agentAnswer(text: string, secrets: readonly string[], redact: (text: string) => string = value => value): string | undefined {
  const safe = scrubAgentText(text, secrets, redact);
  if (!safe) return undefined;
  if (safe.length <= TELEGRAM_ANSWER_LIMIT) return safe;
  let end = TELEGRAM_ANSWER_LIMIT - 1;
  const space = safe.slice(end - 120, end).search(/\s\S*$/);
  if (space >= 0) end = end - 120 + space;
  return `${safe.slice(0, end).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
}
const TELEGRAM_ANSWER_LIMIT = 3500;

/** Redacted, path-scrubbed, bounded end of the message (the question usually closes it). */
export function agentExcerpt(text: string, secrets: readonly string[], redact: (text: string) => string = value => value): string | undefined {
  let safe = scrubAgentText(text, secrets, redact);
  if (!safe) return undefined;
  if (safe.length <= WEBHOOK_AGENT_EXCERPT_LIMIT) return safe;
  let start = safe.length - (WEBHOOK_AGENT_EXCERPT_LIMIT - 1);
  // Start on a word boundary when one is near, and never inside a URL a later redaction must match whole.
  const space = safe.slice(start, start + 120).search(/\s/);
  if (space >= 0) start += space + 1;
  const url = /https?:\/\/\S+/gi;
  for (let match; (match = url.exec(safe));) {
    if (match.index < start && match.index + match[0].length > start) start = match.index + match[0].length;
  }
  safe = safe.slice(start).replace(/^[\uDC00-\uDFFF]/, '').trim();
  return safe ? `…${safe}` : undefined;
}

/**
 * The one path agent prose takes to any chat: the webhook excerpt and the Telegram excerpt and
 * final answer all redact every live receiver's secrets, never a narrower set.
 */
export async function safeAgentText(input: { dataDir: string; runId: string; until: string; kind: 'excerpt' | 'answer';
  receivers: () => readonly PrivateReceiver[]; redact?: (text: string) => string }): Promise<string | undefined> {
  const text = await readLastAgentText(input.dataDir, input.runId, input.until, input.kind === 'answer' ? { boundary: 'message' } : {});
  if (!text) return undefined;
  const secrets = input.receivers().flatMap(receiverSecretValues);
  return (input.kind === 'answer' ? agentAnswer : agentExcerpt)(text, secrets, input.redact);
}
