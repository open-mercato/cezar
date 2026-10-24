/**
 * Durable retry for alerts that could not be delivered even after their in-line retry
 * (spec `.ai/specs/2026-10-21-agent-gateway-integrations.md`).
 *
 * `<project dataDir>/alerts-outbox.ndjson`, one JSON line per undelivered alert. It stores the ALERT
 * (event, task fields, the instant) and the targets still owed — never a request: headers carry the
 * hook token / signature, which must not rest on disk, and a Hermes signature is only valid for 5
 * minutes anyway. A retry rebuilds the request from the CURRENT env, with the same idempotency id
 * (`X-Request-ID` / `idempotencyKey`), so a gateway that did get the first try drops the duplicate and a
 * fixed token or a restarted gateway picks the alert up. Entries die after 24 h; the file holds at most
 * 200 (oldest dropped). Written, never required: deleting the file loses only pending alerts.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const OUTBOX_MAX_ENTRIES = 200;
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_RETRY_MS = 5 * 60 * 1000;

const entrySchema = z.object({
  event: z.enum(['needs-input', 'review', 'done', 'failed', 'cancelled']),
  at: z.number(),
  targets: z.array(z.enum(['openclaw', 'hermes'])).min(1),
  task: z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    project: z.string(),
    branch: z.string().optional(),
    prUrl: z.string().optional(),
    url: z.string().optional(),
    question: z.string().optional(),
    detail: z.string().optional(),
  }),
});
export type OutboxEntry = z.infer<typeof entrySchema>;

export class AlertOutbox {
  private readonly file: string;

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.file = join(dataDir, 'alerts-outbox.ndjson');
  }

  /** Undelivered alerts, oldest first; expired and malformed lines are not returned. */
  load(): OutboxEntry[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const cutoff = this.now() - OUTBOX_MAX_AGE_MS;
    const entries: OutboxEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = entrySchema.safeParse(JSON.parse(line));
        if (parsed.success && parsed.data.at >= cutoff) entries.push(parsed.data);
      } catch {
        // a torn line is not worth failing for
      }
    }
    return entries.slice(-OUTBOX_MAX_ENTRIES);
  }

  /** Never throws: an outbox that cannot be written is just an alert that is not retried. */
  append(entry: OutboxEntry): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      // The cap is enforced on write too, so a gateway that is down for a week cannot grow the file.
      const all = this.load();
      if (all.length >= OUTBOX_MAX_ENTRIES) this.replace(all);
    } catch {
      // see above
    }
  }

  /** Atomic rewrite (tmp + rename); an empty list leaves an empty file rather than a missing one. */
  replace(entries: readonly OutboxEntry[]): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // see append()
    }
  }
}

/** The identity of one owed delivery. */
export const entryKey = (entry: Pick<OutboxEntry, 'task' | 'event' | 'at'>): string => `${entry.task.id}:${entry.event}:${entry.at}`;
