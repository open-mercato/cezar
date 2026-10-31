import { z } from 'zod';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import {
  candidate,
  createEventScanner,
  type EventIssue,
} from './event-scan.ts';
import { TrackerRequestError } from './transport.ts';
const timestamp = z.string().refine((x) => Number.isFinite(Date.parse(x)));
const historySchema = z.array(
  z.object({
    id: z.string().min(1),
    created: timestamp,
    items: z.array(
      z.object({
        fieldId: z.string().optional(),
        field: z.string().optional(),
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
        toString: z.preprocess(
          (x) => (typeof x === 'function' ? undefined : x),
          z.string().nullable().optional(),
        ),
      }),
    ),
  }),
);
export function mapJiraHistory(
  association: TrackerAssociation,
  issue: EventIssue,
  raw: unknown,
) {
  return historySchema
    .parse(raw)
    .flatMap((h) =>
      h.items.flatMap((item, index) =>
        item.fieldId === 'status' || (!item.fieldId && item.field === 'status')
          ? [
              candidate(
                association,
                { ...issue, status: item.toString ?? item.to ?? '' },
                'issue.status_changed',
                `${h.id}:status:${index}`,
                h.created,
                {
                  ...(item.from ? { fromId: item.from } : {}),
                  ...(item.to ? { toId: item.to } : {}),
                },
              ),
            ]
          : [],
      ),
    );
}
/** Jira interprets date literals in the querying account's timezone. Resolve it once per poll
 * (including resumed scans) rather than caching a preference that the user can change independently.
 * Around offset changes, widen discovery by a day to avoid ambiguous repeated local times;
 * the scanner still applies the exact UTC event window and deduplicates candidates. */
function jqlUpdatedSince(iso: string, timeZone: string): string {
  const instant = Date.parse(iso);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const offset = (at: number) => formatter.formatToParts(at).find(p => p.type === 'timeZoneName')?.value;
  const day = 86_400_000;
  const boundary = offset(instant - day) !== offset(instant + day) ? instant - day : instant;
  const parts = Object.fromEntries(formatter.formatToParts(boundary).map(p => [p.type, p.value]));
  return `"${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}"`;
}
export function createJiraEventSource(
  association: TrackerAssociation,
  request: (
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  return {
    poll(input: Parameters<ReturnType<typeof createEventScanner>['poll']>[0]) {
      let timeZone: string | undefined;
      return createEventScanner(
        association,
        async (from, _until, cursor, signal) => {
          if (!timeZone) {
            const profile = z.object({ timeZone: z.string().min(1) }).safeParse(
              await request('/rest/api/3/myself', { method: 'GET' }, signal),
            );
            if (!profile.success) throw new TrackerRequestError('invalid_response', 'Jira account timezone is unavailable. Retry after checking the account settings.');
            timeZone = profile.data.timeZone;
          }
          let since: string;
          try { since = jqlUpdatedSince(from, timeZone); }
          catch { throw new TrackerRequestError('invalid_response', 'Jira returned an unsupported account timezone.'); }
          // No upper updated bound: an issue changing again during discovery must remain discoverable.
          const raw = await request(
            '/rest/api/3/search/jql',
            {
              method: 'POST',
              body: JSON.stringify({
                jql: `project = ${association.externalId} AND updated >= ${since} ORDER BY id ASC`,
                fields: ['project', 'summary', 'created', 'status', 'labels'],
                maxResults: 100,
                ...(cursor ? { nextPageToken: cursor } : {}),
              }),
            },
            signal,
          );
          if (cursor && raw && typeof raw === 'object' && 'errorMessages' in raw)
            throw new TrackerRequestError(
              'invalid_cursor',
              'Jira rejected the continuation token; rescan the unfinished window.',
            );
          const page = z
            .object({
              isLast: z.boolean(),
              nextPageToken: z.string().optional(),
              issues: z.array(
                z.object({
                  id: z.string(),
                  key: z.string(),
                  fields: z.object({
                    project: z.object({ id: z.string() }),
                    summary: z.string(),
                    created: timestamp,
                    status: z.object({ name: z.string() }),
                    labels: z.array(z.string()),
                  }),
                }),
              ),
            })
            .parse(raw);
          if (!page.isLast && !page.nextPageToken)
            throw new TrackerRequestError(
              'invalid_response',
              'Jira pagination is incomplete.',
            );
          return {
            issues: page.issues.map((i) => {
              if (i.fields.project.id !== association.externalId)
                throw new TrackerRequestError(
                  'source_changed',
                  'Jira issue scope changed.',
                );
              return {
                id: i.id,
                key: i.key,
                title: i.fields.summary,
                createdAt: i.fields.created,
                url: `${association.source.webUrl}/browse/${encodeURIComponent(i.key)}`,
                status: i.fields.status.name,
                labels: i.fields.labels,
              };
            }),
            ...(!page.isLast ? { cursor: page.nextPageToken } : {}),
          };
        },
        async (issue, cursor, signal) => {
          const page = z
            .object({
              isLast: z.boolean(),
              startAt: z.number().int().nonnegative(),
              maxResults: z.number().int().positive(),
              values: historySchema,
            })
            .parse(
              await request(
                `/rest/api/3/issue/${encodeURIComponent(issue.id)}/changelog?startAt=${cursor ?? '0'}&maxResults=100`,
                { method: 'GET' },
                signal,
              ),
            );
          if (!page.isLast && !page.values.length)
            throw new TrackerRequestError(
              'invalid_response',
              'Jira history pagination made no progress.',
            );
          return {
            events: mapJiraHistory(association, issue, page.values),
            ...(!page.isLast
              ? { cursor: String(page.startAt + page.values.length) }
              : {}),
          };
        },
        7, // Reserve one request for the account timezone within the existing budget.
      ).poll(input);
    },
  };
}
