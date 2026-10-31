import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  TrackerAssociation,
  TrackerAutomationEvent,
} from '@open-mercato/cezar-contract';
import type { TrackerEventCandidate } from '../../automations/event-source.ts';
import { TrackerRequestError } from './transport.ts';

export type EventPollInput = {
  baselineAt: string;
  checkpoint?: string;
  limit: number;
  signal: AbortSignal;
  event?: TrackerAutomationEvent;
  now?: string;
  /** Absolute soft budget, including provider discovery; the transport keeps its hard deadline. */
  scanDeadlineAt?: number;
};
export const eventIssueSchema = z.object({
  id: z.string().min(1),
  key: z.string(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string().refine((x) => Number.isFinite(Date.parse(x))),
  status: z.string(),
  labels: z.array(z.string()),
});
export type EventIssue = z.infer<typeof eventIssueSchema>;
const eventSchema = z.object({
  eventId: z.string(),
  timestamp: z.string(),
  tieBreaker: z.string(),
  provider: z.enum(['jira', 'linear']),
  event: z.enum([
    'issue.opened',
    'issue.status_changed',
    'issue.labeled',
    'issue.unlabeled',
  ]),
  issueId: z.string(),
  key: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string(),
  labels: z.array(z.string()),
  change: z.object({
    fromId: z.string().optional(),
    toId: z.string().optional(),
    labelId: z.string().optional(),
    labelName: z.string().optional(),
  }),
});
const checkpointSchema = z.object({
  v: z.literal(1),
  fingerprint: z.string(),
  watermark: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
  cursor: z.string().max(4096).optional(),
  discovered: z.boolean(),
  issues: z.array(eventIssueSchema).max(100),
  historyCursor: z.string().max(4096).optional(),
  opened: z.boolean(),
  pending: z.array(eventSchema).max(1000),
});
export function candidate(
  association: TrackerAssociation,
  issue: EventIssue,
  event: TrackerAutomationEvent,
  id: string,
  timestamp: string,
  change: TrackerEventCandidate['change'] = {},
): TrackerEventCandidate {
  const eventId = JSON.stringify([
    association.kind,
    association.source.id,
    association.externalId,
    issue.id,
    id,
    event,
  ]);
  return {
    eventId,
    timestamp: new Date(timestamp).toISOString(),
    tieBreaker: eventId,
    provider: association.kind,
    event,
    association,
    issueId: issue.id,
    key: issue.key,
    title: issue.title,
    url: issue.url,
    status: issue.status,
    labels: issue.labels,
    change,
  };
}
export function createEventScanner(
  association: TrackerAssociation,
  readIssues: (
    from: string,
    until: string,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ issues: EventIssue[]; cursor?: string }>,
  readHistory: (
    issue: EventIssue,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ events: TrackerEventCandidate[]; cursor?: string }>,
  requestBudget = 8,
) {
  return {
    async poll(input: EventPollInput) {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([association, input.event, input.baselineAt]))
        .digest('hex');
      const fresh = () => ({
        v: 1 as const,
        fingerprint,
        watermark: input.baselineAt,
        until: input.now ?? new Date().toISOString(),
        discovered: false,
        issues: [] as EventIssue[],
        opened: false,
        pending: [] as z.infer<typeof eventSchema>[],
      });
      let state: z.infer<typeof checkpointSchema> = fresh();
      if (input.checkpoint) {
        try {
          if (input.checkpoint.length > 2_000_000) throw new Error();
          state = checkpointSchema.parse(JSON.parse(input.checkpoint));
        } catch {
          throw new TrackerRequestError(
            'invalid_cursor',
            'Automation checkpoint is invalid; re-enable to establish a new baseline.',
          );
        }
        // Older pollers scanned every event. Narrowing that same source/baseline
        // is safe: eligibility filters pending events and discovery is unchanged.
        const unfilteredFingerprint = createHash('sha256')
          .update(JSON.stringify([association, undefined, input.baselineAt]))
          .digest('hex');
        if (input.event && state.fingerprint === unfilteredFingerprint) state.fingerprint = fingerprint;
        if (state.fingerprint !== fingerprint)
          throw new TrackerRequestError(
            'invalid_cursor',
            'Automation checkpoint belongs to another source or event.',
          );
        if (
          state.discovered &&
          !state.issues.length &&
          !state.pending.length &&
          !state.cursor
        )
          state = {
            ...fresh(),
            watermark: new Date(
              Math.max(
                Date.parse(input.baselineAt),
                Date.parse(state.until) - 120_000,
              ),
            ).toISOString(),
          };
      }
      const candidates: TrackerEventCandidate[] = [];
      const gaps: { issueId: string; key: string; reason: string }[] = [];
      const limit = Math.max(1, Math.min(100, input.limit));
      let requests = 0;
      let completedPages = 0;
      const scanDeadlineAt = input.scanDeadlineAt ?? Date.now() + 8_000;
      const budgetExpired = new Error('Tracker scan budget exhausted');
      const readPage = async <T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        input.signal.throwIfAborted();
        // Give the first page the full hard deadline: otherwise a healthy nine-second
        // response would never make progress. Once a page completes, preserve it
        // rather than risking the entire scan on another slow page.
        const remaining = scanDeadlineAt - Date.now();
        if (completedPages && remaining <= 0) throw budgetExpired;
        const controller = new AbortController();
        const signal = AbortSignal.any([input.signal, controller.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void;
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (completedPages) timer = setTimeout(() => controller.abort(budgetExpired), remaining);
        });
        try {
          const page = await Promise.race([read(signal), aborted]);
          input.signal.throwIfAborted();
          completedPages++;
          return page;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort!);
        }
      };
      const eligible = (e: {
        event: TrackerAutomationEvent;
        timestamp: string;
      }) =>
        (!input.event || e.event === input.event) &&
        Date.parse(e.timestamp) > Date.parse(state.watermark) &&
        Date.parse(e.timestamp) <= Date.parse(state.until);
      try {
        while (candidates.length < limit) {
          input.signal.throwIfAborted();
          if (state.pending.length) {
            const next = state.pending.shift()!;
            if (eligible(next)) candidates.push({ ...next, association });
            continue;
          }
          if (!state.issues.length) {
            if (state.discovered && !state.cursor) break;
            if (requests >= requestBudget) break; // Leaves source discovery/fallback headroom in the ten-request budget.
            const page = await readPage(signal => readIssues(
              state.watermark,
              state.until,
              state.cursor,
              signal,
            ));
            requests++;
            state.issues = page.issues;
            state.cursor = page.cursor;
            state.discovered = true;
            continue;
          }
          const issue = state.issues[0]!;
          if (!state.opened) {
            state.opened = true;
            const opened = candidate(
              association,
              issue,
              'issue.opened',
              'created',
              issue.createdAt,
            );
            if (eligible(opened)) {
              state.pending.push(opened);
              continue;
            }
          }
          if (input.event === 'issue.opened') {
            state.issues.shift();
            state.opened = false;
            continue;
          }
          if (requests >= requestBudget) break;
          requests++;
          let page: Awaited<ReturnType<typeof readHistory>>;
          try {
            page = await readPage(signal => readHistory(issue, state.historyCursor, signal));
          } catch (error) {
            // A deleted/inaccessible individual issue must not pin the queue head.
            // Authentication and other source-wide failures still stop the scan.
            if (!(error instanceof TrackerRequestError) || error.code !== 'not_found') throw error;
            gaps.push({ issueId: issue.id, key: issue.key, reason: 'Issue history was not found; skipped this issue for the current scan.' });
            state.issues.shift();
            state.historyCursor = undefined;
            state.opened = false;
            continue;
          }
          state.pending.push(...page.events.filter(eligible));
          state.historyCursor = page.cursor;
          if (!page.cursor) {
            state.issues.shift();
            state.opened = false;
          }
        }
      } catch (error) {
        input.signal.throwIfAborted();
        if (error !== budgetExpired) {
          if (!(error instanceof TrackerRequestError) || error.code !== 'invalid_cursor') throw error;
          state = { ...fresh(), watermark: state.watermark, until: state.until };
        }
      }
      // An opened-only page may have consumed its last candidate before clearing its issue.
      if (
        input.event === 'issue.opened' &&
        state.opened &&
        !state.pending.length
      ) {
        state.issues.shift();
        state.opened = false;
      }
      const complete =
        state.discovered &&
        !state.issues.length &&
        !state.pending.length &&
        !state.cursor;
      const validated = checkpointSchema.safeParse(state);
      if (!validated.success)
        throw new TrackerRequestError(
          'invalid_response',
          'Tracker event page exceeded checkpoint bounds.',
        );
      const checkpoint = JSON.stringify(validated.data);
      if (checkpoint.length > 2_000_000)
        throw new TrackerRequestError(
          'invalid_response',
          'Tracker event page exceeded checkpoint bounds.',
        );
      return { candidates, checkpoint, complete, ...(gaps.length ? { gaps } : {}) };
    },
  };
}
