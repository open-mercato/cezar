import { createLinearEventSource, linearEventCapabilities, linearHistoryLimitation } from './linear-events.ts';
import { z } from 'zod';
import type {
  TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidatesQuery,
  TrackerCandidatesResult, TrackerItemsResult, TrackerItemResult, TrackerItem, TrackerSource,
  TrackerListQuery, TrackerSearchQuery,
} from '@open-mercato/cezar-contract';
import type { TrackerProvider, TrackerDriver } from './types.ts';
import { TrackerHttp, TrackerRequestError, ResultCache, requestFailure, runOperation } from './transport.ts';
import { encodeCursor, decodeCursor } from './cursor.ts';
import { descriptionBody } from './adf.ts';

const endpoint = 'https://api.linear.app/graphql';
const sourceQuery = 'query TrackerSource { organization { id urlKey } }';
const teamFields = 'id name';
const pageFields = 'pageInfo { hasNextPage endCursor }';
const issueFields = `identifier title description url createdAt updatedAt creator { name }
  team { id } state { name type } labels(first: 100) { nodes { name } pageInfo { hasNextPage } }`;
const sourceSchema = z.object({ organization: z.object({ id: z.string().min(1), urlKey: z.string().regex(/^[a-zA-Z0-9_-]+$/) }) });
const teamSchema = z.object({ id: z.uuid(), name: z.string().min(1) });
const pageSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).nullable() });
const itemSchema = z.object({
  identifier: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*-\d+$/),
  title: z.string(), description: z.string().nullable(),
  url: z.url(), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
  creator: z.object({ name: z.string() }).nullable(), team: z.object({ id: z.string().min(1) }),
  state: z.object({ name: z.string(), type: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })), pageInfo: z.object({ hasNextPage: z.boolean() }) }),
});
const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ extensions: z.object({ code: z.string().optional() }).passthrough().optional() }).passthrough()).optional(),
});
type Cached = TrackerCandidatesResult | TrackerAssociationResult | TrackerItemsResult | TrackerItemResult;
function invalid(): never { throw new TrackerRequestError('invalid_response', 'Linear returned incomplete or invalid data. Try again.'); }
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}
function wrongSource(): never { throw new TrackerRequestError('source_changed', 'The saved Linear workspace no longer matches the configured key. Reconnect in Settings.'); }
function collectionError(error: unknown) {
  const failure = requestFailure(error);
  return failure.code === 'not_found' ? { available: false as const, code: 'unavailable' as const, reason: 'Linear collection is unavailable.' } : failure;
}
function lookupError(error: unknown) {
  const failure = requestFailure(error);
  return failure.code === 'invalid_cursor' ? { available: false as const, code: 'invalid_response' as const, reason: 'Linear lookup failed.' } : failure;
}

export function createLinearClient(config: { key: string }, fetcher: typeof fetch = fetch):
TrackerProvider {
  const http = new TrackerHttp(fetcher);
  const cache = new ResultCache<Cached>();
  let source: TrackerSource | undefined;
  let sourcePending: Promise<TrackerSource> | undefined;
  let generation = 0;
  const graphql = async (query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    let resetSeconds: number | undefined;
    let status = 200;
    const raw = await http.json(endpoint, {
      method: 'POST', headers: { Authorization: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }, signal, (headers, responseStatus) => {
      status = responseStatus;
      const retry = headers.get('retry-after');
      const windows = ['x-ratelimit-requests', 'x-ratelimit-endpoint-requests', 'x-ratelimit-complexity']
        .map(name => ({ reset: Number(headers.get(name + '-reset')), remaining: headers.get(name + '-remaining') }))
        .filter(window => Number.isFinite(window.reset) && window.reset > Date.now());
      const exhausted = windows.filter(window => window.remaining !== null && Number(window.remaining) === 0);
      if (retry && /^\d+$/.test(retry)) resetSeconds = Number(retry);
      else if (exhausted.length) resetSeconds = Math.ceil((Math.max(...exhausted.map(window => window.reset)) - Date.now()) / 1000);
      else if (windows.length) resetSeconds = Math.ceil((Math.min(...windows.map(window => window.reset)) - Date.now()) / 1000);
      return resetSeconds;
    });
    const envelope = parse(envelopeSchema, raw);
    if (envelope.errors?.length) {
      const codes = envelope.errors.map(error => error.extensions?.code?.toUpperCase());
      if (codes.includes('RATELIMITED')) http.rateLimit(resetSeconds);
      if (codes.some(code => code === 'AUTHENTICATION_ERROR' || code === 'FORBIDDEN' || code === 'UNAUTHENTICATED'))
        throw new TrackerRequestError('unauthorized', 'Linear denied access. Check the API key and read permissions.');
      if (codes.some(code => code === 'NOT_FOUND' || code === 'ENTITY_NOT_FOUND'))
        throw new TrackerRequestError('not_found', 'The requested Linear item was not found in this team.');
      throw new TrackerRequestError('unavailable', 'Linear could not complete the request. Check access and try again.');
    }
    if (status === 400) return invalid();
    if (envelope.data === undefined || envelope.data === null) return invalid();
    return envelope.data;
  };
  const currentSource = async (signal: AbortSignal): Promise<TrackerSource> => {
    if (source) return source;
    if (sourcePending) return sourcePending;
    const gen = generation;
    const pending = graphql(sourceQuery, {}, signal).then(data => {
      const org = parse(sourceSchema, data).organization;
      const value = { id: org.id, webUrl: `https://linear.app/${org.urlKey}` };
      if (generation === gen) source = value;
      return value;
    }).finally(() => { if (sourcePending === pending) sourcePending = undefined; });
    sourcePending = pending;
    return pending;
  };
  const withSource = async <T extends Cached>(signal: AbortSignal, key: unknown, refresh: boolean, read: (current: TrackerSource) => Promise<T>): Promise<T> => {
    const current = await currentSource(signal);
    return cache.get(JSON.stringify([generation, current.id, key]), () => read(current), refresh) as Promise<T>;
  };
  const checkScope = (association: TrackerAssociation, current: TrackerSource) => {
    if (association.kind !== 'linear' || association.source.id !== current.id) wrongSource();
    if (!z.uuid().safeParse(association.externalId).success) invalid();
  };
  const pagination = (page: z.infer<typeof pageSchema>, scope: unknown) => {
    if (page.hasNextPage && !page.endCursor) return invalid();
    return { truncated: page.hasNextPage, ...(page.hasNextPage ? { nextCursor: encodeCursor(scope, page.endCursor!) } : {}) };
  };
  const mapItem = (raw: z.infer<typeof itemSchema>, association: TrackerAssociation, cap: number): TrackerItem => {
    if (raw.team.id !== association.externalId) throw new TrackerRequestError('not_found', 'The requested Linear issue was not found in this team.');
    const url = new URL(raw.url);
    if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.username || url.password || url.port || !url.pathname.includes('/issue/')) return invalid();
    if (raw.labels.pageInfo.hasNextPage) return invalid();
    return {
      kind: 'issue', id: raw.identifier, title: raw.title, author: raw.creator?.name ?? '',
      createdAt: raw.createdAt, updatedAt: raw.updatedAt, labels: raw.labels.nodes.map(label => label.name),
      ...descriptionBody(raw.description ?? '', cap), url: raw.url, status: raw.state.name,
    };
  };
  const listCandidates = async (query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> => {
    try {
      return await runOperation(signal => withSource(signal, ['teams', query], false, async current => {
        const scope = [current.id, 'teams', query.q, query.limit];
        const after = decodeCursor(scope, query.cursor);
        const data = await graphql(`query TrackerTeams($first: Int!, $after: String, $filter: TeamFilter) {
          teams(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${teamFields} } ${pageFields} }
        }`, { first: query.limit, ...(after ? { after } : {}), ...(query.q ? { filter: { or: [{ name: { containsIgnoreCase: query.q } }, { key: { containsIgnoreCase: query.q } }] } } : {}) }, signal);
        const page = parse(z.object({ teams: z.object({ nodes: z.array(teamSchema), pageInfo: pageSchema }) }), data).teams;
        return { available: true, source: current, candidates: page.nodes, ...pagination(page.pageInfo, scope) };
      }));
    } catch (error) { return collectionError(error); }
  };
  const resolveAssociation = async (input: TrackerAssociationInput): Promise<TrackerAssociationResult> => {
    try {
      return await runOperation(signal => withSource(signal, ['team', input], false, async current => {
        if (input.kind !== 'linear' || input.sourceId !== current.id) wrongSource();
        if (!z.uuid().safeParse(input.externalId).success) throw new TrackerRequestError('not_found', 'The selected Linear team was not found.');
        const data = await graphql(`query TrackerTeam($id: String!) { team(id: $id) { ${teamFields} } }`, { id: input.externalId }, signal);
        const team = parse(z.object({ team: teamSchema.nullable() }), data).team;
        if (!team) throw new TrackerRequestError('not_found', 'The selected Linear team was not found.');
        if (team.id !== input.externalId) return invalid();
        return { available: true, association: { kind: 'linear', source: current, externalId: team.id, externalName: team.name } };
      }));
    } catch (error) { return lookupError(error); }
  };
  const driver = (association: TrackerAssociation): TrackerDriver => {
    const read = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
      try {
        const { refresh: _, ...key } = query;
        return await runOperation(signal => withSource(signal, [association, key], query.refresh === '1', async current => {
          checkScope(association, current);
          const scope = [current.id, association.externalId, key.limit, key.state, key.labels, 'q' in key ? key.q : null];
          const after = decodeCursor(scope, query.cursor);
          const filter = {
            team: { id: { eq: association.externalId } },
            ...(query.state === 'active' ? { state: { type: { nin: ['completed', 'canceled'] } } } : {}),
            ...(query.labels?.length ? { and: query.labels.map(name => ({ labels: { some: { name: { eq: name } } } })) } : {}),
          };
          const search = 'q' in query;
          const data = await graphql(`query TrackerIssues($first: Int!, $after: String, $filter: IssueFilter${search ? ', $term: String!' : ''}) {
            result: ${search ? 'searchIssues' : 'issues'}(first: $first, after: $after, filter: $filter, orderBy: updatedAt, includeArchived: true${search ? ', term: $term, includeComments: false' : ''}) {
              nodes { ${issueFields.replace('labels(first: 100)', 'labels(first: 50)')} } ${pageFields}
            }
          }`, { first: query.limit, ...(after ? { after } : {}), filter, ...(search ? { term: query.q } : {}) }, signal);
          const page = parse(z.object({ result: z.object({ nodes: z.array(itemSchema), pageInfo: pageSchema }) }), data).result;
          return { available: true, items: page.nodes.map(row => mapItem(row, association, 8000)), ...pagination(page.pageInfo, scope) };
        }));
      } catch (error) { return collectionError(error); }
    };
    return {
      association, listIssues: read, searchItems: read,
      async automationOptions(query) {
        if (query?.cursor) throw new TrackerRequestError('invalid_cursor', 'This options catalog has no next page.');
        return { events: linearEventCapabilities, limitations: [linearHistoryLimitation], statuses: [], labels: [] };
      },
      async pollEvents(input) {
        if (input.event && input.event !== 'issue.opened') throw new TrackerRequestError('unavailable', linearHistoryLimitation);
        return runOperation(async deadline => {
          const scanDeadlineAt = Date.now() + 8_000;
          const signal = AbortSignal.any([input.signal, deadline]);
          const current = await currentSource(signal);
          checkScope(association, current);
          return createLinearEventSource(association, graphql).poll({ ...input, event: 'issue.opened', signal, scanDeadlineAt });
        }).catch(error => {
          if (error instanceof z.ZodError) throw new TrackerRequestError('invalid_response', 'Tracker returned incomplete automation event data.');
          throw error;
        });
      },
      async getItem(id): Promise<TrackerItemResult> {
        try {
          if (!/^[a-zA-Z][a-zA-Z0-9_]*-\d+$/.test(id) || id.length > 256) throw new TrackerRequestError('not_found', 'The requested Linear issue was not found.');
          // Browser detail cache owns freshness; retain in-flight deduplication, not stale reads.
          return await runOperation(signal => withSource(signal, [association, 'issue', id], true, async current => {
            checkScope(association, current);
            const data = await graphql(`query TrackerIssue($id: String!) { issue(id: $id) { ${issueFields} } }`, { id }, signal);
            const row = parse(z.object({ issue: itemSchema.nullable() }), data).issue;
            if (!row) throw new TrackerRequestError('not_found', 'The requested Linear issue was not found.');
            return { available: true, item: mapItem(row, association, 60000) };
          }));
        } catch (error) { return lookupError(error); }
      },
    };
  };
  return {
    kind: 'linear', listCandidates, resolveAssociation, driver,
    clearCache() { generation++; source = undefined; sourcePending = undefined; cache.clear(); },
  };
}
