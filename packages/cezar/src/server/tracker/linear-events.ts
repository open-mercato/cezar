import { z } from 'zod';
import type {
  TrackerAssociation,
  TrackerAutomationEvent,
} from '@open-mercato/cezar-contract';
import {
  candidate,
  createEventScanner,
  type EventIssue,
} from './event-scan.ts';
import { TrackerRequestError } from './transport.ts';
export const linearEventCapabilities: TrackerAutomationEvent[] = [
  'issue.opened',
];
export const linearHistoryLimitation =
  'Linear omits changes during the first three minutes and groups activity changes. Status and label events are unavailable until complete history can be verified.';
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const historySchema = z.array(
  z.object({
    id: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    fromStateId: z.string().nullable().optional(),
    toStateId: z.string().nullable().optional(),
    addedLabelIds: z.array(z.string()).nullable().optional(),
    removedLabelIds: z.array(z.string()).nullable().optional(),
  }),
);
export function mapLinearHistory(
  association: TrackerAssociation,
  issue: EventIssue,
  raw: unknown,
) {
  return historySchema.parse(raw).flatMap((h) => [
    ...(h.toStateId
      ? [
          candidate(
            association,
            issue,
            'issue.status_changed',
            `${h.id}:status`,
            h.createdAt,
            {
              ...(h.fromStateId ? { fromId: h.fromStateId } : {}),
              toId: h.toStateId,
            },
          ),
        ]
      : []),
    ...(h.addedLabelIds ?? []).map((id) =>
      candidate(
        association,
        issue,
        'issue.labeled',
        `${h.id}:label:${id}`,
        h.createdAt,
        { labelId: id },
      ),
    ),
    ...(h.removedLabelIds ?? []).map((id) =>
      candidate(
        association,
        issue,
        'issue.unlabeled',
        `${h.id}:label:${id}`,
        h.createdAt,
        { labelId: id },
      ),
    ),
  ]);
}
export function createLinearEventSource(
  association: TrackerAssociation,
  graphql: (
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  return createEventScanner(
    association,
    async (from, _until, cursor, signal) => {
      const raw = await graphql(
        `
          query AutomationIssues($after: String, $filter: IssueFilter) {
            issues(
              first: 100
              after: $after
              filter: $filter
              orderBy: createdAt
              includeArchived: true
            ) {
              nodes {
                id
                identifier
                title
                url
                createdAt
                team {
                  id
                }
                state {
                  name
                }
                labels(first: 100) {
                  pageInfo {
                    hasNextPage
                  }
                  nodes {
                    name
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          after: cursor,
          filter: {
            team: { id: { eq: association.externalId } },
            updatedAt: { gte: from },
          },
        },
        signal,
      );
      // Ordinary transport failures must propagate without resetting scan progress.
      // Only an explicit invalid_cursor classification may restart an unfinished window.
      const page = z
        .object({
          issues: z.object({
            nodes: z.array(
              z.object({
                id: z.string(),
                identifier: z.string(),
                title: z.string(),
                url: z.url(),
                createdAt: z.iso.datetime({ offset: true }),
                team: z.object({ id: z.string() }),
                state: z.object({ name: z.string() }),
                labels: z.object({
                  pageInfo: z.object({ hasNextPage: z.boolean() }),
                  nodes: z.array(z.object({ name: z.string() })),
                }),
              }),
            ),
            pageInfo,
          }),
        })
        .parse(raw).issues;
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor)
        throw new TrackerRequestError(
          'invalid_response',
          'Linear pagination is incomplete.',
        );
      return {
        issues: page.nodes.map((i) => {
          // Never filter automation events against an incomplete label snapshot.
          if (i.labels.pageInfo.hasNextPage)
            throw new TrackerRequestError(
              'invalid_response',
              'Linear issue labels are incomplete; automation polling cannot continue.',
            );
          if (i.team.id !== association.externalId)
            throw new TrackerRequestError(
              'source_changed',
              'Linear issue scope changed.',
            );
          return {
            id: i.id,
            key: i.identifier,
            title: i.title,
            url: i.url,
            createdAt: i.createdAt,
            status: i.state.name,
            labels: i.labels.nodes.map((x) => x.name),
          };
        }),
        ...(page.pageInfo.hasNextPage
          ? { cursor: page.pageInfo.endCursor! }
          : {}),
      };
    },
    async (issue, cursor, signal) => {
      const page = z
        .object({
          issue: z.object({
            id: z.string(),
            history: z.object({ nodes: historySchema, pageInfo }),
          }),
        })
        .parse(
          await graphql(
            `
              query AutomationHistory($id: String!, $after: String) {
                issue(id: $id) {
                  id
                  history(
                    first: 100
                    after: $after
                    includeArchived: true
                    orderBy: createdAt
                  ) {
                    nodes {
                      id
                      createdAt
                      fromStateId
                      toStateId
                      addedLabelIds
                      removedLabelIds
                    }
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                  }
                }
              }
            `,
            { id: issue.id, after: cursor },
            signal,
          ),
        ).issue;
      if (page.id !== issue.id)
        throw new TrackerRequestError(
          'source_changed',
          'Linear issue changed.',
        );
      if (page.history.pageInfo.hasNextPage && !page.history.pageInfo.endCursor)
        throw new TrackerRequestError(
          'invalid_response',
          'Linear history pagination is incomplete.',
        );
      return {
        events: mapLinearHistory(association, issue, page.history.nodes),
        ...(page.history.pageInfo.hasNextPage
          ? { cursor: page.history.pageInfo.endCursor! }
          : {}),
      };
    },
  );
}
