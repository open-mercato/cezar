import { createJiraEventSource } from './jira-events.ts';
import { boundedContext, CONTEXT_DESCRIPTION_LIMIT } from './context-limits.ts';
import { z } from 'zod';
import type {
  TrackerContext,
  TrackerAction,
  TrackerAssociation,
  TrackerAssociationInput,
  TrackerAssociationResult,
  TrackerCandidatesQuery,
  TrackerCandidatesResult,
  TrackerItem,
  TrackerItemResult,
  TrackerItemsResult,
  TrackerListQuery,
  TrackerSearchQuery,
  TrackerSource,
} from '@open-mercato/cezar-contract';
import { adfMarkdown, descriptionBody } from './adf.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import {
  ResultCache,
  TrackerHttp,
  TrackerRequestError,
  requestFailure,
  runOperation,
  isResponseSizeLimit,
} from './transport.ts';
import type { TrackerProvider, TrackerDriver } from './types.ts';

const tenantSchema = z.object({ cloudId: z.string().min(1) });
const projectSchema = z.object({
  id: z.string().regex(/^\d+$/),
  key: z.string().min(1),
  name: z.string().min(1),
});
const projectPageSchema = z.object({
  startAt: z.number().int().nonnegative(),
  maxResults: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  isLast: z.boolean(),
  values: z.array(projectSchema),
});
const issueSchema = z.object({
  id: z.string().min(1),
  key: z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9]\d*$/),
  fields: z.object({
    project: z.object({ id: z.string().regex(/^\d+$/) }),
    summary: z.string(),
    creator: z.object({ displayName: z.string().min(1) }).nullable(),
    created: z.string().min(1),
    updated: z.string().min(1),
    labels: z.array(z.string()),
    description: z.unknown().nullable(),
    status: z.object({ name: z.string() }),
  }),
});
const issuePageSchema = z.object({
  isLast: z.boolean(),
  nextPageToken: z.string().min(1).optional(),
  issues: z.array(issueSchema),
});

type JiraIssue = z.infer<typeof issueSchema>;
type CachedResult = TrackerCandidatesResult | TrackerAssociationResult | TrackerItemsResult | TrackerItemResult;
type Transport = 'gateway' | 'site';

const issueFields = ['project', 'summary', 'creator', 'created', 'updated', 'labels', 'description', 'status'] as const;
const issueKeyPattern = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

function invalidResponse(reason = 'Jira returned an invalid response. Try again later.'): never {
  throw new TrackerRequestError('invalid_response', reason);
}

function parseVendor<T>(schema: z.ZodType<T>, value: unknown): T {
  if (value && typeof value === 'object' && ('errorMessages' in value || 'errors' in value)) {
    throw new TrackerRequestError('unavailable', 'Jira rejected the request. Check the query and try again.');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}

function collectionFailure(error: unknown): Extract<TrackerCandidatesResult | TrackerItemsResult, { available: false }> {
  const failure = requestFailure(error);
  if (failure.code === 'not_found') {
    return { available: false, code: 'unavailable', reason: 'Jira could not serve this collection. Try again later.' };
  }
  return failure;
}

function lookupFailure(error: unknown): Extract<TrackerAssociationResult | TrackerItemResult, { available: false }> {
  const failure = requestFailure(error);
  if (failure.code === 'invalid_cursor') {
    return { available: false, code: 'invalid_response', reason: 'Jira returned an invalid response. Try again later.' };
  }
  return failure;
}

function normalizeTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return invalidResponse('Jira returned an invalid issue timestamp.');
  return new Date(milliseconds).toISOString();
}

function mapIssue(raw: JiraIssue, origin: string, expectedProjectId: string, maximum: number): TrackerItem {
  if (raw.fields.project.id !== expectedProjectId) {
    throw new TrackerRequestError('not_found', 'The requested Jira issue was not found in this project.');
  }
  const converted = adfMarkdown(raw.fields.description);
  const body = descriptionBody(converted.body, maximum, converted.unsupportedContent);
  return {
    kind: 'issue',
    id: raw.key,
    title: raw.fields.summary,
    author: raw.fields.creator?.displayName ?? 'Unknown',
    createdAt: normalizeTimestamp(raw.fields.created),
    updatedAt: normalizeTimestamp(raw.fields.updated),
    labels: raw.fields.labels,
    ...body,
    url: `${origin}/browse/${encodeURIComponent(raw.key)}`,
    status: raw.fields.status.name,
  };
}

function quoteJql(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;
}

function jqlFor(projectId: string, query: TrackerListQuery | TrackerSearchQuery): string {
  const clauses = [`project = ${projectId}`];
  if (query.state === 'active') clauses.push('statusCategory != Done');
  for (const label of query.labels ?? []) clauses.push(`labels = ${quoteJql(label)}`);
  if ('q' in query) {
    const value = quoteJql(query.q);
    clauses.push(issueKeyPattern.test(query.q)
      ? `(key = ${value} OR text ~ ${value})`
      : `text ~ ${value}`);
  }
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

function sourceChanged(): TrackerRequestError {
  return new TrackerRequestError(
    'source_changed',
    'The saved Jira site no longer matches the configured credentials. Reconnect the project.',
  );
}

export function createJiraClient(
  config: { origin: string; email: string; token: string },
  fetcher: typeof fetch = fetch,
): TrackerProvider {
  const http = new TrackerHttp(fetcher);
  const cache = new ResultCache<CachedResult>(200, 60_000);
  const authorization = `Basic ${Buffer.from(`${config.email}:${config.token}`, 'utf8').toString('base64')}`;
  let sourceValue: TrackerSource | undefined;
  let sourcePending: Promise<TrackerSource> | undefined;
  let transport: Transport | undefined;
  let generation = 0;

  const source = async (signal: AbortSignal): Promise<TrackerSource> => {
    if (sourceValue) return sourceValue;
    if (sourcePending) return sourcePending;
    const currentGeneration = generation;
    const pending = http.json(`${config.origin}/_edge/tenant_info`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, signal).then(value => {
      const tenant = parseVendor(tenantSchema, value);
      const resolved = { id: tenant.cloudId, webUrl: config.origin };
      if (generation === currentGeneration) sourceValue = resolved;
      return resolved;
    }).finally(() => {
      if (sourcePending === pending) sourcePending = undefined;
    });
    sourcePending = pending;
    return pending;
  };

  const authenticatedJson = async (
    currentSource: TrackerSource,
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const headers = {
      Accept: 'application/json',
      Authorization: authorization,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    const request = (selected: Transport) => {
      const base = selected === 'gateway'
        ? `https://api.atlassian.com/ex/jira/${encodeURIComponent(currentSource.id)}`
        : config.origin;
      return http.json(`${base}${path}`, { ...init, headers }, signal, undefined, { allowEmpty: init.method === 'POST' });
    };

    if (transport === 'site') return request('site');
    try {
      const result = await request('gateway');
      transport = 'gateway';
      return result;
    } catch (error) {
      // JQL searches use POST but are reads. Only reads may try another transport;
      // a mutation must never be sent twice after an uncertain response.
      const readOnly = init.method === 'GET' || (init.method === 'POST' && path === '/rest/api/3/search/jql');
      if (!readOnly || !(error instanceof TrackerRequestError) || error.code !== 'unauthorized') throw error;
      const result = await request('site');
      transport = 'site';
      return result;
    }
  };

  const withSource = async <T extends CachedResult>(
    signal: AbortSignal,
    operation: string,
    scope: unknown,
    refresh: boolean,
    read: (currentSource: TrackerSource) => Promise<T>,
  ): Promise<T> => {
    const currentSource = await source(signal);
    const key = JSON.stringify(['jira', currentSource.id, currentSource.webUrl, operation, scope]);
    return cache.get(key, () => read(currentSource), refresh) as Promise<T>;
  };

  const ensureAssociationSource = (association: TrackerAssociation, currentSource: TrackerSource): void => {
    if (association.kind !== 'jira'
      || association.source.id !== currentSource.id
      || association.source.webUrl !== currentSource.webUrl
      || !/^\d+$/.test(association.externalId)) {
      throw sourceChanged();
    }
  };

  const listCandidates = async (query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> => {
    try {
      return await runOperation(signal => withSource(
        signal,
        'candidates',
        { q: query.q ?? '', cursor: query.cursor ?? '', limit: query.limit },
        false,
        async currentSource => {
          if (query.kind !== 'jira') throw sourceChanged();
          const cursorScope = {
            kind: 'jira', source: currentSource, operation: 'candidates', q: query.q ?? '', limit: query.limit,
          };
          const position = decodeCursor(cursorScope, query.cursor);
          if (position !== undefined && !/^(0|[1-9]\d*)$/.test(position)) {
            throw new TrackerRequestError('invalid_cursor', 'This Jira project page expired. Start the search again.');
          }
          const startAt = position === undefined ? 0 : Number(position);
          if (!Number.isSafeInteger(startAt)) {
            throw new TrackerRequestError('invalid_cursor', 'This Jira project page expired. Start the search again.');
          }
          const params = new URLSearchParams({
            startAt: String(startAt),
            maxResults: String(query.limit),
            orderBy: 'name',
          });
          if (query.q !== undefined) params.set('query', query.q);
          const raw = await authenticatedJson(currentSource, `/rest/api/3/project/search?${params}`, { method: 'GET' }, signal);
          const page = parseVendor(projectPageSchema, raw);
          if (!page.isLast && page.maxResults < 1) return invalidResponse();
          const truncated = !page.isLast;
          return {
            available: true,
            source: currentSource,
            candidates: page.values.map(project => ({ id: project.id, name: project.name })),
            truncated,
            ...(truncated
              ? { nextCursor: encodeCursor(cursorScope, String(page.startAt + page.maxResults)) }
              : {}),
          };
        },
      ));
    } catch (error) {
      return collectionFailure(error);
    }
  };

  const resolveAssociation = async (input: TrackerAssociationInput): Promise<TrackerAssociationResult> => {
    try {
      return await runOperation(signal => withSource(
        signal,
        'association',
        { kind: input.kind, externalId: input.externalId, sourceId: input.sourceId },
        false,
        async currentSource => {
          if (input.kind !== 'jira' || input.sourceId !== currentSource.id) throw sourceChanged();
          if (!/^\d+$/.test(input.externalId)) {
            throw new TrackerRequestError('not_found', 'The selected Jira project was not found.');
          }
          const raw = await authenticatedJson(
            currentSource,
            `/rest/api/3/project/${encodeURIComponent(input.externalId)}`,
            { method: 'GET' },
            signal,
          );
          const project = parseVendor(projectSchema, raw);
          if (project.id !== input.externalId) return invalidResponse();
          return {
            available: true,
            association: {
              kind: 'jira',
              source: currentSource,
              externalId: project.id,
              externalName: project.name,
            },
          };
        },
      ));
    } catch (error) {
      return lookupFailure(error);
    }
  };

  const driver = (association: TrackerAssociation): TrackerDriver => {
    const readItems = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
      try {
        const { refresh: _refresh, ...cacheQuery } = query;
        return await runOperation(signal => withSource(
          signal,
          'issues',
          { association, query: cacheQuery },
          query.refresh === '1',
          async currentSource => {
            ensureAssociationSource(association, currentSource);
            const cursorScope = {
              kind: 'jira', source: currentSource, operation: 'issues', externalId: association.externalId,
              state: query.state, labels: query.labels ?? [], ...('q' in query ? { q: query.q } : {}), limit: query.limit,
            };
            const nextPageToken = decodeCursor(cursorScope, query.cursor);
            const body = {
              jql: jqlFor(association.externalId, query),
              fields: [...issueFields],
              maxResults: query.limit,
              ...(nextPageToken === undefined ? {} : { nextPageToken }),
            };
            const raw = await authenticatedJson(currentSource, '/rest/api/3/search/jql', {
              method: 'POST',
              body: JSON.stringify(body),
            }, signal);
            const page = parseVendor(issuePageSchema, raw);
            if (!page.isLast && page.nextPageToken === undefined) return invalidResponse();
            const items = page.issues.map(value => mapIssue(value, config.origin, association.externalId, 8_000));
            const truncated = !page.isLast;
            return {
              available: true,
              items,
              truncated,
              ...(truncated ? { nextCursor: encodeCursor(cursorScope, page.nextPageToken!) } : {}),
            };
          },
        ));
      } catch (error) {
        return collectionFailure(error);
      }
    };

    const getItem = async (id: string): Promise<TrackerItemResult> => {
      try {
        if (!issueKeyPattern.test(id) || id.length > 256) {
          throw new TrackerRequestError('not_found', 'The requested Jira issue was not found in this project.');
        }
        return await runOperation(signal => withSource(
          signal,
          'issue',
          { association, id },
          // Browser detail cache owns freshness; a new request must revalidate the vendor.
          true,
          async currentSource => {
            ensureAssociationSource(association, currentSource);
            const params = new URLSearchParams({ fields: issueFields.join(',') });
            const raw = await authenticatedJson(
              currentSource,
              `/rest/api/3/issue/${encodeURIComponent(id)}?${params}`,
              { method: 'GET' },
              signal,
            );
            const parsed = parseVendor(issueSchema, raw);
            // Jira resolves historical keys after rename/move. Numeric project scope
            // in mapIssue is authoritative; return the canonical current key.
            return {
              available: true,
              item: mapIssue(parsed, config.origin, association.externalId, 60_000),
            };
          },
        ));
      } catch (error) {
        return lookupFailure(error);
      }
    };

    const context = async (id: string): Promise<TrackerContext> => runOperation(async signal => {
      if (!/^(?:[A-Z][A-Z0-9_]*-[1-9]\d*|[1-9]\d*)$/.test(id)) throw new TrackerRequestError('not_found', 'Invalid issue identity.');
      const current = await source(signal);
      ensureAssociationSource(association, current);
      const raw = await authenticatedJson(current, `/rest/api/3/issue/${encodeURIComponent(id)}?fields=${issueFields.join(',')}`, { method: 'GET' }, signal);
      const row = parseVendor(issueSchema.extend({ fields: issueSchema.shape.fields.extend({ status: z.object({ id: z.string(), name: z.string() }) }) }), raw);
      const item = mapIssue(row, config.origin, association.externalId, CONTEXT_DESCRIPTION_LIMIT);
      const comments: TrackerContext['comments'] = [];
      let offset = 0, lossyComments = 0, pagesExhausted = false;
      for (let pageNumber = 0; ; pageNumber++) {
        if (pageNumber >= 100) { pagesExhausted = true; break; }
        // Newest first, so a page or size bound drops the oldest discussion; reversed below.
        let raw: unknown;
        try { raw = await authenticatedJson(current, `/rest/api/3/issue/${encodeURIComponent(row.id)}/comment?startAt=${offset}&maxResults=50&orderBy=-created`, { method: 'GET' }, signal); }
        catch (error) { if (!isResponseSizeLimit(error)) throw error; pagesExhausted = true; break; }
        const page = parseVendor(z.object({ startAt: z.number(), total: z.number(), comments: z.array(z.object({ id: z.string(), body: z.unknown(), created: z.string(), author: z.object({ displayName: z.string() }).optional() })) }), raw);
        if (page.startAt !== offset) return invalidResponse();
        for (const comment of page.comments) {
          const body = adfMarkdown(comment.body);
          if (body.unsupportedContent) lossyComments++;
          comments.push({ id: comment.id, body: body.body, author: comment.author?.displayName ?? 'Unknown', createdAt: comment.created });
        }
        offset += page.comments.length;
        if (offset >= page.total) break;
        if (!page.comments.length) return invalidResponse();
      }
      comments.reverse();
      const transitions = parseVendor(z.object({ transitions: z.array(z.object({ id: z.string(), name: z.string(), to: z.object({ id: z.string() }), fields: z.record(z.string(), z.object({ required: z.boolean(), hasDefaultValue: z.boolean().optional() })).optional() })) }), await authenticatedJson(current, `/rest/api/3/issue/${encodeURIComponent(row.id)}/transitions?expand=transitions.fields`, { method: 'GET' }, signal));
      return boundedContext({ issueId: row.id, item, statusId: row.fields.status.id, fetchedAt: new Date().toISOString(), comments,
        limitations: ['Only accessible comments are included. Attachments and custom fields are not included; if required, stop and report missing context.', 'Transitions requiring additional fields are not supported.'],
        transitions: transitions.transitions.filter(t => !Object.values(t.fields ?? {}).some(f => f.required && !f.hasDefaultValue)).map(t => ({ id: t.id, name: t.name, statusId: t.to.id })) },
      { description: Boolean(item.unsupportedContent), comments: lossyComments, pagesExhausted });
    }, 30000);
    const act = async (id: string, action: TrackerAction, beforeWrite?: () => Promise<void>): Promise<void> => {
      const fresh = await context(id);
      if (action.kind === 'transition' && (fresh.statusId !== action.expectedStatusId || !fresh.transitions.some(t => t.id === action.transitionId))) throw new TrackerRequestError('unavailable', 'Status changed or transition is unavailable. Read the issue again.');
      await runOperation(async signal => {
        const current = await source(signal);
        ensureAssociationSource(association, current);
        // Last check before the request leaves: everything earlier is a known "not sent".
        await beforeWrite?.();
        const path = `/rest/api/3/issue/${encodeURIComponent(fresh.issueId)}/${action.kind === 'comment' ? 'comment' : 'transitions'}`;
        const body = action.kind === 'comment'
          ? { body: { type: 'doc', version: 1, content: action.body.split('\n').map(text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })) } }
          : { transition: { id: action.transitionId } };
        const result = await authenticatedJson(current, path, { method: 'POST', body: JSON.stringify(body) }, signal);
        if (action.kind === 'comment') parseVendor(z.object({ id: z.string().min(1) }), result);
      });
    };

    return {
      association, context, act,
      async automationOptions(query) {
        if (query?.cursor) throw new TrackerRequestError('invalid_cursor', 'This options catalog has no next page.');
        return runOperation(async signal => {
          const current = await source(signal);
          ensureAssociationSource(association, current);
          const raw = await authenticatedJson(current, `/rest/api/3/project/${encodeURIComponent(association.externalId)}/statuses`, { method: 'GET' }, signal);
          const rows = parseVendor(z.array(z.object({ statuses: z.array(z.object({ id: z.string(), name: z.string() })) })), raw);
          const statuses = [...new Map(rows.flatMap(row => row.statuses).map(status => [status.id, status])).values()];
          return { events: ['issue.opened' as const, 'issue.status_changed' as const], statuses: query?.search ? statuses.filter(status => status.name.toLowerCase().includes(query.search!.toLowerCase())) : statuses, labels: [], limitations: ['Jira label history encoding has not been verified; label events are unavailable. Archived or inaccessible issues are not discoverable by Jira search.'] };
        });
      },
      async pollEvents(input) {
        if (input.event && !['issue.opened', 'issue.status_changed'].includes(input.event)) throw new TrackerRequestError('unavailable', 'This Jira event is unavailable.');
        return runOperation(async deadline => {
          const scanDeadlineAt = Date.now() + 8_000;
          const signal = AbortSignal.any([input.signal, deadline]);
          const current = await source(signal);
          ensureAssociationSource(association, current);
          return createJiraEventSource(association, (path, init, requestSignal) => authenticatedJson(current, path, init, requestSignal)).poll({ ...input, signal, scanDeadlineAt });
        }).catch(error => {
          if (error instanceof z.ZodError) throw new TrackerRequestError('invalid_response', 'Tracker returned incomplete automation event data.');
          throw error;
        });
      },
      listIssues: readItems,
      searchItems: readItems,
      getItem,
    };
  };

  return {
    kind: 'jira',
    listCandidates,
    resolveAssociation,
    driver,
    clearCache() {
      generation++;
      sourceValue = undefined;
      sourcePending = undefined;
      transport = undefined;
      cache.clear();
    },
  };
}
