import type { TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery, TrackerCandidatesResult, TrackerItemsResult, TrackerItemResult, TrackerKind, TrackerListQuery, TrackerSearchQuery, TrackerItem } from '@open-mercato/cezar-contract';
import type { TrackerProvider, TrackerDriver } from './types.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { descriptionBody } from './adf.ts';
import { requestFailure } from './transport.ts';

const FIXTURES = {
  jira: { webUrl: 'https://demo.atlassian.net', scopeLabel: 'Project', prefix: 'DEMO', itemPath: 'browse' },
  linear: { webUrl: 'https://linear.app/demo', scopeLabel: 'Team', prefix: 'ENG', itemPath: 'issue' },
} satisfies Record<TrackerKind, { webUrl: string; scopeLabel: string; prefix: string; itemPath: string }>;

/** Offline fixture covers pagination and long context without inheriting host credentials. */
export function createDryTrackerClient(kind: TrackerKind): TrackerProvider {
  const fixture = FIXTURES[kind];
  const source = { id: `dry-${kind}`, webUrl: fixture.webUrl };
  const candidate = (n: number) => ({ id: String(n), name: `${fixture.scopeLabel} ${n}` });
  const all = Array.from({ length: 125 }, (_, i) => candidate(i + 1));
  const wrongSource = { available: false, code: 'source_changed', reason: 'Tracker source changed. Reconnect in Settings.' } as const;
  const missing = { available: false, code: 'not_found', reason: 'Tracker item not found in this scope.' } as const;
  function item(n: number, association: TrackerAssociation, cap: number): TrackerItem {
    const prefix = `${fixture.prefix}${association.externalId}`;
    const id = `${prefix}-${n}`;
    return {
      kind: 'issue', id, title: n === 1 ? 'Improve account sign-in' : `Tracker task ${n}`,
      author: 'Demo user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 125 - n)).toISOString(),
      labels: n % 2 ? ['backend'] : ['frontend'], status: n % 5 ? 'In Progress' : 'Done',
      ...descriptionBody(n === 3 ? 'Large import requirements. '.repeat(3000) : n === 2 ? 'Detailed requirements. '.repeat(500) + '\nAcceptance: preserve all requirements.' : `Implement task ${n} for ${association.externalName}.\n\n- Preserve existing behavior.\n- Add regression coverage.`, cap, n === 4),
      url: `${source.webUrl}/${fixture.itemPath}/${id}`,
    };
  }
  function page<T>(items: T[], limit: number, cursor: string | undefined, scope: unknown) {
    const offset = Number(decodeCursor(scope, cursor) ?? '0');
    const sliced = items.slice(offset, offset + limit);
    const truncated = offset + limit < items.length;
    return { sliced, truncated, ...(truncated ? { nextCursor: encodeCursor(scope, String(offset + limit)) } : {}) };
  }
  function collectionError(error: unknown) {
    const failure = requestFailure(error);
    return failure.code === 'not_found' ? { available: false as const, code: 'unavailable' as const, reason: failure.reason } : failure;
  }
  return {
    kind,
    clearCache() {},
    async listCandidates(query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> {
      try {
        const found = all.filter(row => !query.q || row.name.toLowerCase().includes(query.q.toLowerCase()));
        const { sliced, ...pagination } = page(found, query.limit, query.cursor, [kind, 'candidates', query.q, query.limit]);
        return { available: true, source, candidates: sliced, ...pagination };
      } catch (error) { return collectionError(error); }
    },
    async resolveAssociation(input: TrackerAssociationInput): Promise<TrackerAssociationResult> {
      if (input.kind !== kind || input.sourceId !== source.id) return wrongSource;
      const found = all.find(row => row.id === input.externalId);
      return found ? { available: true, association: { kind, source, externalId: found.id, externalName: found.name } } : missing;
    },
    driver(association: TrackerAssociation): TrackerDriver {
      const valid = () => association.kind === kind && association.source.id === source.id && association.source.webUrl === source.webUrl && all.some(row => row.id === association.externalId);
      const read = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
        if (!valid()) return wrongSource;
        try {
          const q = 'q' in query ? query.q.toLowerCase() : '';
          const found = all.map((_, i) => item(i + 1, association, 8000)).filter(row => (query.state === 'all' || row.status !== 'Done') && (!q || `${row.id} ${row.title} ${row.body}`.toLowerCase().includes(q)) && (query.labels ?? []).every(label => row.labels.includes(label)));
          const { sliced, ...pagination } = page(found, query.limit, query.cursor, [association, q, query.state, query.labels, query.limit]);
          return { available: true, items: sliced, ...pagination };
        } catch (error) { return collectionError(error); }
      };
      return {
        association, listIssues: read, searchItems: read,
        async getItem(id: string): Promise<TrackerItemResult> {
          if (!valid()) return wrongSource;
          const prefix = `${fixture.prefix}${association.externalId}`;
          const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
          const n = Number(match?.[1]);
          return n >= 1 && n <= 125 ? { available: true, item: item(n, association, 60000) } : missing;
        },
      };
    },
  };
}
