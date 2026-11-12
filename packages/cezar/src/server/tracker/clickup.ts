import { z } from 'zod';
import type {
  TrackerAssociation, TrackerAssociationInput, TrackerAssociationResult, TrackerCandidate, TrackerCandidatesQuery,
  TrackerCandidatesResult, TrackerItemsResult, TrackerItemResult, TrackerItem, TrackerSource,
  TrackerListQuery, TrackerSearchQuery,
} from '@open-mercato/cezar-contract';
import type { TrackerProvider, TrackerDriver } from './types.ts';
import { TrackerHttp, TrackerRequestError, ResultCache, requestFailure, runOperation } from './transport.ts';
import { encodeCursor, decodeCursor } from './cursor.ts';
import { descriptionBody } from './adf.ts';

const api = 'https://api.clickup.com/api/v2';
const vendorPageSize = 100;
// ClickUp has no task text search: search scans a bounded window and continues through the cursor.
const scanPages = 3;
const scanBudgetMs = 8_000;
// Task rows carry every custom field, so a full page runs well past the 2 MB default.
const responseCap = 8 * 1024 * 1024;
const scopePattern = /^(space|folder|list):(\d+)$/;
const taskIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

const idSchema = z.union([z.string().min(1), z.number()]).transform(String);
const namedSchema = z.object({ id: idSchema, name: z.string().min(1) });
const teamsSchema = z.object({ teams: z.array(namedSchema) });
const spacesSchema = z.object({ spaces: z.array(namedSchema) });
const foldersSchema = z.object({ folders: z.array(namedSchema) });
const listsSchema = z.object({ lists: z.array(namedSchema) });
const folderSchema = namedSchema.extend({ space: namedSchema });
const listSchema = namedSchema.extend({
  space: namedSchema,
  folder: z.object({ id: idSchema, name: z.string(), hidden: z.boolean().optional() }).nullish(),
});
const refSchema = z.object({ id: idSchema });
const millisSchema = z.union([z.string().regex(/^\d+$/), z.number()]).transform(Number);
const taskSchema = z.object({
  id: z.string().regex(taskIdPattern), custom_id: z.string().nullish(), name: z.string(),
  description: z.string().nullish(), markdown_description: z.string().nullish(), text_content: z.string().nullish(),
  status: z.object({ status: z.string(), type: z.string() }),
  creator: z.object({ username: z.string().nullish() }).nullish(),
  tags: z.array(z.object({ name: z.string() })).nullish(),
  url: z.url(), date_created: millisSchema, date_updated: millisSchema.nullish(),
  team_id: idSchema.nullish(), space: refSchema, folder: refSchema, list: refSchema,
  locations: z.array(refSchema).nullish(),
});
const tasksSchema = z.object({ tasks: z.array(taskSchema), last_page: z.boolean().optional() });
type Task = z.infer<typeof taskSchema>;
type Scope = { level: 'space' | 'folder' | 'list'; id: string };
type Cached = TrackerCandidatesResult | TrackerAssociationResult | TrackerItemsResult | TrackerItemResult;

function invalid(): never { throw new TrackerRequestError('invalid_response', 'ClickUp returned incomplete or invalid data. Try again.'); }
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}
function wrongSource(): never { throw new TrackerRequestError('source_changed', 'The saved ClickUp workspace no longer matches the configured token. Reconnect in Settings.'); }
function missingScope(): never { throw new TrackerRequestError('not_found', 'The selected ClickUp space, folder or list was not found.'); }
function collectionError(error: unknown) {
  const failure = requestFailure(error);
  return failure.code === 'not_found' ? { available: false as const, code: 'unavailable' as const, reason: 'ClickUp collection is unavailable.' } : failure;
}
function lookupError(error: unknown) {
  const failure = requestFailure(error);
  return failure.code === 'invalid_cursor' ? { available: false as const, code: 'invalid_response' as const, reason: 'ClickUp lookup failed.' } : failure;
}
function parseScope(externalId: string): Scope | undefined {
  const match = scopePattern.exec(externalId);
  return match ? { level: match[1] as Scope['level'], id: match[2]! } : undefined;
}
const resetHint = (headers: Headers) => {
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.ceil(reset - Date.now() / 1000) : undefined;
};
const isoTime = (millis: number) => {
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? invalid() : date.toISOString();
};

/** Subfolders are their own scope: a folder holds the tasks directly in it (spec 2026-10-31-clickup-tracker). */
function inScope(task: Task, scope: Scope, source: TrackerSource): boolean {
  if (task.team_id && task.team_id !== source.id) return false;
  if (scope.level === 'space') return task.space.id === scope.id;
  if (scope.level === 'folder') return task.folder.id === scope.id;
  return task.list.id === scope.id || (task.locations ?? []).some(location => location.id === scope.id);
}
function mapItem(task: Task, cap: number): TrackerItem {
  const url = new URL(task.url);
  if (url.protocol !== 'https:' || url.hostname !== 'app.clickup.com' || url.username || url.password || url.port || !url.pathname.startsWith('/t/')) return invalid();
  const createdAt = isoTime(task.date_created);
  return {
    kind: 'issue', id: task.id, title: task.name, author: task.creator?.username ?? '',
    createdAt, updatedAt: task.date_updated ? isoTime(task.date_updated) : createdAt,
    labels: (task.tags ?? []).map(tag => tag.name),
    ...descriptionBody(task.markdown_description || task.text_content || task.description || '', cap),
    url: task.url, status: task.status.status,
  };
}
function matchesFilters(task: Task, query: TrackerListQuery | TrackerSearchQuery): boolean {
  // Re-checked locally: the docs do not state AND semantics for tags[] or whether include_closed hides `done`.
  if (query.state === 'active' && ['closed', 'done'].includes(task.status.type)) return false;
  const tags = (task.tags ?? []).map(tag => tag.name.toLowerCase());
  return (query.labels ?? []).every(label => tags.includes(label.toLowerCase()));
}
function matchesText(task: Task, term: string): boolean {
  return [task.id, task.custom_id, task.name, task.text_content, task.markdown_description, task.description]
    .some(value => value?.toLowerCase().includes(term));
}

export function createClickUpClient(config: { token: string; workspaceId?: string }, fetcher: typeof fetch = fetch): TrackerProvider {
  const http = new TrackerHttp(fetcher, responseCap);
  const cache = new ResultCache<Cached>();
  let source: TrackerSource | undefined;
  let sourcePending: Promise<TrackerSource> | undefined;
  let generation = 0;
  const get = (path: string, params: URLSearchParams | undefined, signal: AbortSignal): Promise<unknown> => {
    const query = params?.size ? `?${params}` : '';
    return http.json(`${api}${path}${query}`, { headers: { Authorization: config.token } }, signal, resetHint);
  };
  const notArchived = () => new URLSearchParams({ archived: 'false' });
  const currentSource = async (signal: AbortSignal): Promise<TrackerSource> => {
    if (source) return source;
    if (sourcePending) return sourcePending;
    const gen = generation;
    const pending = get('/team', undefined, signal).then(data => {
      const { teams } = parse(teamsSchema, data);
      const team = config.workspaceId ? teams.find(row => row.id === config.workspaceId) : teams.length === 1 ? teams[0] : undefined;
      if (!team && config.workspaceId) throw new TrackerRequestError('unauthorized', 'This token cannot access the configured ClickUp workspace. Check the workspace ID.');
      if (!team && teams.length === 0) throw new TrackerRequestError('unauthorized', 'This token cannot access any ClickUp workspace.');
      if (!team) throw new TrackerRequestError('unavailable', `This token reaches several ClickUp workspaces. Save the connection again with one workspace ID: ${teams.slice(0, 10).map(row => `${row.name} (${row.id})`).join(', ')}.`);
      const value = { id: team.id, webUrl: `https://app.clickup.com/${team.id}` };
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
  const checkScope = (association: TrackerAssociation, current: TrackerSource): Scope => {
    if (association.kind !== 'clickup' || association.source.id !== current.id) wrongSource();
    return parseScope(association.externalId) ?? invalid();
  };
  const spaces = async (current: TrackerSource, signal: AbortSignal) =>
    parse(spacesSchema, await get(`/team/${current.id}/space`, notArchived(), signal)).spaces;

  const candidatesUnder = async (parent: string | undefined, current: TrackerSource, signal: AbortSignal): Promise<TrackerCandidate[]> => {
    if (!parent) return (await spaces(current, signal)).map(row => ({ id: `space:${row.id}`, name: row.name, hasChildren: true }));
    const scope = parseScope(parent);
    if (scope?.level === 'space') {
      const [folders, lists] = await Promise.all([
        get(`/space/${scope.id}/folder`, notArchived(), signal).then(data => parse(foldersSchema, data).folders),
        get(`/space/${scope.id}/list`, notArchived(), signal).then(data => parse(listsSchema, data).lists),
      ]);
      return [
        ...folders.map(row => ({ id: `folder:${row.id}`, name: row.name, hasChildren: true })),
        ...lists.map(row => ({ id: `list:${row.id}`, name: row.name })),
      ];
    }
    if (scope?.level === 'folder') {
      const { lists } = parse(listsSchema, await get(`/folder/${scope.id}/list`, notArchived(), signal));
      return lists.map(row => ({ id: `list:${row.id}`, name: row.name }));
    }
    return missingScope();
  };
  const listCandidates = async (query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> => {
    try {
      return await runOperation(signal => withSource(signal, ['candidates', query], false, async current => {
        if (query.kind !== 'clickup') wrongSource();
        const scope = [current.id, 'candidates', query.parent ?? null, query.q ?? null, query.limit];
        const offset = Number(decodeCursor(scope, query.cursor) ?? '0');
        const term = query.q?.toLowerCase();
        // These vendor responses are complete, so filtering here is not first-page filtering.
        const rows = (await candidatesUnder(query.parent, current, signal)).filter(row => !term || row.name.toLowerCase().includes(term));
        const end = offset + query.limit;
        const truncated = end < rows.length;
        return { available: true, source: current, candidates: rows.slice(offset, end), truncated, ...(truncated ? { nextCursor: encodeCursor(scope, String(end)) } : {}) };
      }));
    } catch (error) { return collectionError(error); }
  };

  /** The space is what proves a folder or list belongs to this token's workspace. */
  const resolvePath = async (scope: Scope, current: TrackerSource, signal: AbortSignal): Promise<string> => {
    const known = await spaces(current, signal);
    const owned = (spaceId: string) => known.find(row => row.id === spaceId) ?? missingScope();
    if (scope.level === 'space') return owned(scope.id).name;
    if (scope.level === 'folder') {
      const folder = parse(folderSchema, await get(`/folder/${scope.id}`, undefined, signal));
      if (folder.id !== scope.id) return invalid();
      return `${owned(folder.space.id).name} / ${folder.name}`;
    }
    const list = parse(listSchema, await get(`/list/${scope.id}`, undefined, signal));
    if (list.id !== scope.id) return invalid();
    return [owned(list.space.id).name, ...(list.folder && !list.folder.hidden ? [list.folder.name] : []), list.name].join(' / ');
  };
  const resolveAssociation = async (input: TrackerAssociationInput): Promise<TrackerAssociationResult> => {
    try {
      return await runOperation(signal => withSource(signal, ['association', input], false, async current => {
        if (input.kind !== 'clickup' || input.sourceId !== current.id) wrongSource();
        const scope = parseScope(input.externalId) ?? missingScope();
        const externalName = await resolvePath(scope, current, signal);
        return { available: true, association: { kind: 'clickup', source: current, externalId: input.externalId, externalName } };
      }));
    } catch (error) { return lookupError(error); }
  };

  const fetchTask = async (id: string, custom: boolean, current: TrackerSource, signal: AbortSignal): Promise<Task> => {
    const params = new URLSearchParams({ include_markdown_description: 'true' });
    if (custom) { params.set('custom_task_ids', 'true'); params.set('team_id', current.id); }
    return parse(taskSchema, await get(`/task/${encodeURIComponent(id)}`, params, signal));
  };
  /** A term shaped like a task ID finds it wherever it sits, without scanning. Custom IDs carry a hyphen. */
  const exactMatch = async (term: string, current: TrackerSource, signal: AbortSignal): Promise<Task | undefined> => {
    if (!taskIdPattern.test(term) || !/\d/.test(term)) return undefined;
    try { return await fetchTask(term, term.includes('-'), current, signal); }
    catch (error) {
      if (error instanceof TrackerRequestError && ['not_found', 'unauthorized', 'invalid_response'].includes(error.code)) return undefined;
      throw error;
    }
  };

  const driver = (association: TrackerAssociation): TrackerDriver => {
    const read = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
      try {
        const { refresh: _, ...key } = query;
        return await runOperation(signal => withSource(signal, [association, key], query.refresh === '1', async current => {
          const scope = checkScope(association, current);
          const term = 'q' in query ? query.q : undefined;
          const cursorScope = [current.id, association.externalId, key.limit, key.state, key.labels, term ?? null];
          const position = /^(\d+):(\d+)$/.exec(decodeCursor(cursorScope, query.cursor) ?? '0:0') ?? invalid();
          let page = Number(position[1]);
          let offset = Number(position[2]);
          const lower = term?.toLowerCase();
          const items: TrackerItem[] = [];
          const seen = new Set<string>();
          const accepts = (task: Task) => inScope(task, scope, current) && matchesFilters(task, query) && !seen.has(task.id);
          const take = (task: Task) => { seen.add(task.id); items.push(mapItem(task, 8000)); };
          if (term && !query.cursor) {
            const exact = await exactMatch(term, current, signal);
            if (exact && accepts(exact)) take(exact);
          }
          const params = new URLSearchParams({
            order_by: 'updated', subtasks: 'true', include_markdown_description: 'true',
            include_closed: query.state === 'all' ? 'true' : 'false',
          });
          params.append(`${{ space: 'space_ids', folder: 'project_ids', list: 'list_ids' }[scope.level]}[]`, scope.id);
          for (const label of query.labels ?? []) params.append('tags[]', label);
          const continued = (nextPage: number, nextOffset: number) => ({
            available: true as const, items, truncated: true, nextCursor: encodeCursor(cursorScope, `${nextPage}:${nextOffset}`),
          });
          const startedAt = Date.now();
          for (let fetched = 1; ; fetched++) {
            params.set('page', String(page));
            const { tasks, last_page } = parse(tasksSchema, await get(`/team/${current.id}/task`, params, signal));
            for (; offset < tasks.length; offset++) {
              if (items.length >= query.limit) return continued(page, offset);
              const task = tasks[offset]!;
              if (accepts(task) && (!lower || matchesText(task, lower))) take(task);
            }
            if (tasks.length === 0 || (last_page ?? tasks.length < vendorPageSize)) return { available: true, items, truncated: false };
            page++;
            offset = 0;
            if (items.length >= query.limit || fetched >= scanPages || Date.now() - startedAt >= scanBudgetMs) return continued(page, 0);
          }
        }));
      } catch (error) { return collectionError(error); }
    };
    return {
      association, listIssues: read, searchItems: read,
      async getItem(id): Promise<TrackerItemResult> {
        try {
          if (!taskIdPattern.test(id)) throw new TrackerRequestError('not_found', 'The requested ClickUp task was not found.');
          // Browser detail cache owns freshness; retain in-flight deduplication, not stale reads.
          return await runOperation(signal => withSource(signal, [association, 'task', id], true, async current => {
            const scope = checkScope(association, current);
            const task = await fetchTask(id, false, current, signal);
            if (!inScope(task, scope, current)) throw new TrackerRequestError('not_found', 'The requested ClickUp task was not found in this scope.');
            return { available: true, item: mapItem(task, 60000) };
          }));
        } catch (error) { return lookupError(error); }
      },
    };
  };
  return {
    kind: 'clickup', listCandidates, resolveAssociation, driver,
    clearCache() { generation++; source = undefined; sourcePending = undefined; cache.clear(); },
  };
}
