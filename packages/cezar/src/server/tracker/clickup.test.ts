import { describe, it, expect, vi } from 'vitest';
import { trackerItemsResultSchema, type TrackerAssociation } from '@open-mercato/cezar-contract';
import { createClickUpClient } from './clickup.ts';

const source = { id: '900', webUrl: 'https://app.clickup.com/900' };
const association: TrackerAssociation = { kind: 'clickup', source, externalId: 'space:10', externalName: 'Acme' };
const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, custom_id: null, name: `Task ${id}`, description: 'plain', markdown_description: `**detail** ${id}`, text_content: 'plain',
  status: { status: 'in progress', type: 'custom' }, creator: { username: 'Ada' }, tags: [{ name: 'backend' }],
  url: `https://app.clickup.com/t/${id}`, date_created: '1767225600000', date_updated: '1767312000000', team_id: '900',
  space: { id: '10' }, folder: { id: '20' }, list: { id: '30' }, locations: [], ...over,
});
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
type Route = (url: URL) => Response | undefined;
function mock(route: Route, config: { workspaceId?: string } = {}, teams: unknown[] = [{ id: '900', name: 'Acme' }]) {
  const requests: URL[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.clickup.com');
    expect(init?.headers).toMatchObject({ Authorization: 'pk_secret' });
    expect(init?.redirect).toBe('error');
    requests.push(url);
    if (url.pathname === '/api/v2/team') return json({ teams });
    return route(url) ?? json({ err: 'unexpected' }, 500);
  }) as unknown as typeof fetch;
  return { client: createClickUpClient({ token: 'pk_secret', ...config }, fetcher), requests };
}
const tasksRoute = (pages: unknown[][], lastPage?: boolean): Route => url => {
  if (url.pathname !== '/api/v2/team/900/task') return undefined;
  const page = Number(url.searchParams.get('page'));
  return json({ tasks: pages[page] ?? [], ...(lastPage === undefined ? {} : { last_page: lastPage && page >= pages.length - 1 }) });
};
const fullPage = (prefix: string, over: Record<string, unknown> = {}) => Array.from({ length: 100 }, (_, i) => task(`${prefix}${i}`, over));
const list = { state: 'all' as const, limit: 50 };

describe('workspace discovery', () => {
  it('uses the only workspace without asking and never contacts ClickUp at construction', async () => {
    const { client, requests } = mock(url => url.pathname === '/api/v2/team/900/space' ? json({ spaces: [] }) : undefined);
    expect(requests).toHaveLength(0);
    expect(await client.listCandidates({ kind: 'clickup', limit: 50 })).toMatchObject({ available: true, source });
  });
  it('names the workspaces instead of picking one when the token reaches several', async () => {
    const { client } = mock(() => undefined, {}, [{ id: '900', name: 'Acme' }, { id: '901', name: 'Beta' }]);
    const result = await client.listCandidates({ kind: 'clickup', limit: 50 });
    expect(result).toMatchObject({ available: false, code: 'unavailable' });
    expect(!result.available && result.reason).toContain('Beta (901)');
  });
  it('honours a configured workspace and refuses one the token cannot reach', async () => {
    const teams = [{ id: '900', name: 'Acme' }, { id: '901', name: 'Beta' }];
    const chosen = mock(url => url.pathname === '/api/v2/team/901/space' ? json({ spaces: [] }) : undefined, { workspaceId: '901' }, teams);
    expect(await chosen.client.listCandidates({ kind: 'clickup', limit: 50 })).toMatchObject({ available: true, source: { id: '901' } });
    const foreign = mock(() => undefined, { workspaceId: '999' }, teams);
    expect(await foreign.client.listCandidates({ kind: 'clickup', limit: 50 })).toMatchObject({ available: false, code: 'unauthorized' });
  });
});

describe('scope picker', () => {
  const hierarchy: Route = url => {
    if (url.pathname === '/api/v2/team/900/space') return json({ spaces: Array.from({ length: 57 }, (_, i) => ({ id: String(i + 1), name: `Space ${i + 1}` })) });
    if (url.pathname === '/api/v2/space/10/folder') return json({ folders: [{ id: '20', name: 'Development', lists: [] }] });
    if (url.pathname === '/api/v2/space/10/list') return json({ lists: [{ id: '31', name: 'Loose list' }] });
    if (url.pathname === '/api/v2/folder/20/list') return json({ lists: [{ id: '30', name: 'Sprint' }] });
    return undefined;
  };
  it('reads only one level per request, so a big workspace stays cheap', async () => {
    const { client, requests } = mock(hierarchy);
    const first = await client.listCandidates({ kind: 'clickup', limit: 50 });
    if (!first.available) throw new Error('fixture failed');
    expect(first.candidates[0]).toEqual({ id: 'space:1', name: 'Space 1', hasChildren: true });
    expect(first.truncated).toBe(true);
    expect(requests.map(url => url.pathname)).toEqual(['/api/v2/team', '/api/v2/team/900/space']);
    const second = await client.listCandidates({ kind: 'clickup', limit: 50, cursor: first.nextCursor });
    expect(second.available && second.candidates).toHaveLength(7);
  });
  it('opens a space onto folders and folderless lists, and a folder onto lists', async () => {
    const { client } = mock(hierarchy);
    expect(await client.listCandidates({ kind: 'clickup', limit: 50, parent: 'space:10' })).toMatchObject({ candidates: [
      { id: 'folder:20', name: 'Development', hasChildren: true }, { id: 'list:31', name: 'Loose list' },
    ] });
    expect(await client.listCandidates({ kind: 'clickup', limit: 50, parent: 'folder:20' })).toMatchObject({ candidates: [{ id: 'list:30', name: 'Sprint' }] });
  });
  it('rejects a parent that cannot be opened and a cursor from another parent', async () => {
    const { client } = mock(hierarchy);
    expect(await client.listCandidates({ kind: 'clickup', limit: 50, parent: 'list:30' })).toMatchObject({ available: false, code: 'unavailable' });
    expect(await client.listCandidates({ kind: 'clickup', limit: 50, parent: '../team' })).toMatchObject({ available: false, code: 'unavailable' });
    const first = await client.listCandidates({ kind: 'clickup', limit: 50 });
    if (!first.available) throw new Error('fixture failed');
    expect(await client.listCandidates({ kind: 'clickup', limit: 50, parent: 'space:10', cursor: first.nextCursor })).toMatchObject({ code: 'invalid_cursor' });
  });
  it('filters a level by name across all of it, not just the first page', async () => {
    const { client } = mock(hierarchy);
    expect(await client.listCandidates({ kind: 'clickup', limit: 50, q: 'SPACE 57' })).toMatchObject({ candidates: [{ id: 'space:57' }], truncated: false });
  });
});

describe('connecting a scope', () => {
  const route: Route = url => {
    if (url.pathname === '/api/v2/team/900/space') return json({ spaces: [{ id: '10', name: 'Acme' }] });
    if (url.pathname === '/api/v2/folder/20') return json({ id: '20', name: 'Development', space: { id: '10', name: 'Acme' } });
    if (url.pathname === '/api/v2/folder/21') return json({ id: '21', name: 'Foreign', space: { id: '77', name: 'Other' } });
    if (url.pathname === '/api/v2/list/30') return json({ id: '30', name: 'Sprint', folder: { id: '20', name: 'Development', hidden: false }, space: { id: '10', name: 'Acme' } });
    if (url.pathname === '/api/v2/list/31') return json({ id: '31', name: 'Loose', folder: { id: '22', name: 'hidden', hidden: true }, space: { id: '10', name: 'Acme' } });
    return undefined;
  };
  const resolve = (client: ReturnType<typeof mock>['client'], externalId: string, sourceId = '900') => client.resolveAssociation({ kind: 'clickup', sourceId, externalId });
  it.each([
    ['space:10', 'Acme'], ['folder:20', 'Acme / Development'], ['list:30', 'Acme / Development / Sprint'], ['list:31', 'Acme / Loose'],
  ])('resolves %s to the server-side path %s', async (externalId, externalName) => {
    expect(await resolve(mock(route).client, externalId)).toMatchObject({ available: true, association: { kind: 'clickup', source, externalId, externalName } });
  });
  it('rejects a scope outside this workspace, a malformed scope and a changed workspace', async () => {
    const { client } = mock(route);
    expect(await resolve(client, 'space:77')).toMatchObject({ code: 'not_found' });
    expect(await resolve(client, 'folder:21')).toMatchObject({ code: 'not_found' });
    expect(await resolve(client, '10')).toMatchObject({ code: 'not_found' });
    expect(await resolve(client, 'space:10', '901')).toMatchObject({ code: 'source_changed' });
  });
});

describe('reading tasks', () => {
  it.each([
    ['space:10', 'space_ids[]', '10'], ['folder:20', 'project_ids[]', '20'], ['list:30', 'list_ids[]', '30'],
  ])('filters %s by %s', async (externalId, param, value) => {
    const { client, requests } = mock(tasksRoute([[task('a1')]]));
    const result = await client.driver({ ...association, externalId }).listIssues(list);
    expect(result).toMatchObject({ available: true, items: [{ id: 'a1' }], truncated: false });
    const url = requests.at(-1)!;
    expect(url.searchParams.getAll(param)).toEqual([value]);
    expect(url.searchParams.get('order_by')).toBe('updated');
    expect(url.searchParams.get('subtasks')).toBe('true');
    expect(url.searchParams.get('include_closed')).toBe('true');
  });
  it('maps a task onto the common TrackerItem shape', async () => {
    const { client } = mock(tasksRoute([[task('a1')]]));
    const result = await client.driver(association).listIssues(list);
    expect(trackerItemsResultSchema.safeParse(result).success).toBe(true);
    expect(result.available && result.items[0]).toEqual({
      kind: 'issue', id: 'a1', title: 'Task a1', author: 'Ada', labels: ['backend'], status: 'in progress',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', url: 'https://app.clickup.com/t/a1',
      body: '**detail** a1', bodyTruncated: false, unsupportedContent: false,
    });
  });
  it('falls back from an empty markdown description and tolerates a task with no creator or update time', async () => {
    const { client } = mock(tasksRoute([[task('a1', { markdown_description: '', creator: null, date_updated: null, tags: null })]]));
    expect(await client.driver(association).listIssues(list)).toMatchObject({ items: [{
      body: 'plain', author: '', labels: [], updatedAt: '2026-01-01T00:00:00.000Z',
    }] });
  });
  it('walks past a vendor page boundary without losing or repeating a row', async () => {
    const { client } = mock(tasksRoute([fullPage('a'), [task('b0')]]));
    const driver = client.driver(association);
    const ids: string[] = [];
    let cursor: string | undefined;
    let reads = 0;
    do {
      const page = await driver.listIssues({ ...list, ...(cursor ? { cursor } : {}) });
      if (!page.available) throw new Error('read failed');
      ids.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor && ++reads < 10);
    expect(ids).toHaveLength(101);
    expect(new Set(ids).size).toBe(101);
    expect(ids.at(-1)).toBe('b0');
  });
  it('treats a short page as the end when ClickUp sends no last_page, and honours it when it does', async () => {
    const short = mock(tasksRoute([[task('a1')]]));
    await short.client.driver(association).listIssues(list);
    expect(short.requests.filter(url => url.pathname.endsWith('/task'))).toHaveLength(1);
    const exact = mock(tasksRoute([fullPage('a')], true));
    expect(await exact.client.driver(association).listIssues({ ...list, limit: 100 })).toMatchObject({ truncated: false });
    expect(exact.requests.filter(url => url.pathname.endsWith('/task'))).toHaveLength(1);
  });
  it('keeps AND label semantics and hides closed and done tasks from the active view', async () => {
    const { client, requests } = mock(tasksRoute([[
      task('both', { tags: [{ name: 'a' }, { name: 'b' }] }), task('one', { tags: [{ name: 'a' }] }),
      task('closed', { status: { status: 'closed', type: 'closed' }, tags: [{ name: 'a' }, { name: 'b' }] }),
      task('done', { status: { status: 'shipped', type: 'done' }, tags: [{ name: 'a' }, { name: 'b' }] }),
    ]]));
    expect(await client.driver(association).listIssues({ state: 'active', limit: 50, labels: ['a', 'B'] })).toMatchObject({ items: [{ id: 'both' }] });
    const url = requests.at(-1)!;
    expect(url.searchParams.get('include_closed')).toBe('false');
    expect(url.searchParams.getAll('tags[]')).toEqual(['a', 'B']);
  });
  it('drops rows from another scope or workspace', async () => {
    const { client } = mock(tasksRoute([[task('in'), task('out', { space: { id: '11' } }), task('foreign', { team_id: '901' })]]));
    expect(await client.driver(association).listIssues(list)).toMatchObject({ items: [{ id: 'in' }] });
  });
  it('counts a task living in a second list as a member of that list', async () => {
    const { client } = mock(tasksRoute([[task('home', { list: { id: '30' } }), task('also', { list: { id: '99' }, locations: [{ id: '30' }] }), task('no', { list: { id: '99' } })]]));
    expect(await client.driver({ ...association, externalId: 'list:30' }).listIssues(list)).toMatchObject({ items: [{ id: 'home' }, { id: 'also' }] });
  });
  it('holds a folder to its own tasks and rejects a malformed saved scope', async () => {
    const { client } = mock(tasksRoute([[task('direct'), task('sub', { folder: { id: '21' } })]]));
    expect(await client.driver({ ...association, externalId: 'folder:20' }).listIssues(list)).toMatchObject({ items: [{ id: 'direct' }] });
    expect(await client.driver({ ...association, externalId: '10' }).listIssues(list)).toMatchObject({ code: 'invalid_response' });
  });
  it('rejects a changed workspace before reading tasks', async () => {
    const { client, requests } = mock(tasksRoute([[task('a1')]]));
    expect(await client.driver({ ...association, source: { ...source, id: '901' } }).listIssues(list)).toMatchObject({ code: 'source_changed' });
    expect(requests.filter(url => url.pathname.endsWith('/task'))).toHaveLength(0);
  });
  it('binds cursors to the scope and filters', async () => {
    const { client } = mock(tasksRoute([fullPage('a'), [task('b0')]]));
    const first = await client.driver(association).listIssues(list);
    if (!first.available) throw new Error('fixture failed');
    expect(await client.driver(association).listIssues({ state: 'active', limit: 50, cursor: first.nextCursor })).toMatchObject({ code: 'invalid_cursor' });
    expect(await client.driver({ ...association, externalId: 'space:11' }).listIssues({ ...list, cursor: first.nextCursor })).toMatchObject({ code: 'invalid_cursor' });
  });
  it('rejects an unsafe task URL', async () => {
    const { client } = mock(tasksRoute([[task('a1', { url: 'https://evil.test/t/a1' })]]));
    expect(await client.driver(association).listIssues(list)).toMatchObject({ code: 'invalid_response' });
  });
});

describe('searching, which ClickUp does not offer', () => {
  const search = { state: 'all' as const, limit: 50 };
  it('matches title, description and custom ID case-insensitively', async () => {
    const { client } = mock(tasksRoute([[
      task('a1', { name: 'Fix LOGIN page' }), task('a2', { markdown_description: 'see login flow' }),
      task('a3', { custom_id: 'LOGIN' }), task('a4'),
    ]]));
    const result = await client.driver(association).searchItems({ ...search, q: 'login' });
    expect(result.available && result.items.map(item => item.id)).toEqual(['a1', 'a2', 'a3']);
  });
  it('stops at the scan window and says there is more, even on an empty result, then finds a match further on', async () => {
    const { client, requests } = mock(tasksRoute([fullPage('a'), fullPage('b'), fullPage('c'), fullPage('d'), [task('e0', { name: 'needle' })]]));
    const first = await client.driver(association).searchItems({ ...search, q: 'needle' });
    expect(first).toMatchObject({ available: true, items: [], truncated: true });
    expect(requests.filter(url => url.pathname.endsWith('/task'))).toHaveLength(3);
    if (!first.available) throw new Error('fixture failed');
    expect(await client.driver(association).searchItems({ ...search, q: 'needle', cursor: first.nextCursor })).toMatchObject({ items: [{ id: 'e0' }], truncated: false });
  });
  it('finds a task by native ID directly, first, and without repeating it from the scan', async () => {
    const { client, requests } = mock(url => {
      if (url.pathname === '/api/v2/task/86abc') return json(task('86abc'));
      return tasksRoute([[task('x1', { name: 'mentions 86abc' }), task('86abc')]])(url);
    });
    const result = await client.driver(association).searchItems({ ...search, q: '86abc' });
    expect(result.available && result.items.map(item => item.id)).toEqual(['86abc', 'x1']);
    expect(requests.find(url => url.pathname === '/api/v2/task/86abc')?.searchParams.has('custom_task_ids')).toBe(false);
  });
  it('looks a hyphenated term up as a custom ID within this workspace', async () => {
    const { client, requests } = mock(url => {
      if (url.pathname === '/api/v2/task/ENG-12') return json(task('86abc', { custom_id: 'ENG-12' }));
      return tasksRoute([[]])(url);
    });
    expect(await client.driver(association).searchItems({ ...search, q: 'ENG-12' })).toMatchObject({ items: [{ id: '86abc' }] });
    const lookup = requests.find(url => url.pathname === '/api/v2/task/ENG-12')!;
    expect(lookup.searchParams.get('custom_task_ids')).toBe('true');
    expect(lookup.searchParams.get('team_id')).toBe('900');
  });
  it.each([[404], [401]])('falls through to the scan when an ID lookup answers HTTP%s', async status => {
    const { client } = mock(url => url.pathname.startsWith('/api/v2/task/') ? json({ err: 'nope' }, status) : tasksRoute([[task('a1', { name: 'v2 plan' })]])(url));
    expect(await client.driver(association).searchItems({ ...search, q: 'v2' })).toMatchObject({ items: [{ id: 'a1' }] });
  });
  it('does not surface a directly looked-up task from another scope', async () => {
    const { client } = mock(url => url.pathname === '/api/v2/task/86abc' ? json(task('86abc', { space: { id: '11' } })) : tasksRoute([[]])(url));
    expect(await client.driver(association).searchItems({ ...search, q: '86abc' })).toMatchObject({ available: true, items: [] });
  });
  it('does not spend an ID lookup on an ordinary word', async () => {
    const { client, requests } = mock(tasksRoute([[]]));
    await client.driver(association).searchItems({ ...search, q: 'login' });
    expect(requests.filter(url => url.pathname.startsWith('/api/v2/task/'))).toHaveLength(0);
  });
});

describe('task detail', () => {
  const route = (over: Record<string, unknown> = {}): Route => url => url.pathname === '/api/v2/task/a1' ? json(task('a1', over)) : undefined;
  it('reads the full description, beyond the list excerpt', async () => {
    const { client, requests } = mock(url => route({ markdown_description: 'x'.repeat(61_000) })(url) ?? tasksRoute([[task('a1', { markdown_description: 'x'.repeat(61_000) })]])(url));
    const driver = client.driver(association);
    const excerpt = await driver.listIssues(list);
    expect(excerpt.available && excerpt.items[0]?.body.length).toBe(8000);
    const detail = await driver.getItem('a1');
    expect(detail.available && detail.item.body.length).toBe(60000);
    expect(detail.available && detail.item.bodyTruncated).toBe(true);
    expect(requests.at(-1)?.searchParams.get('include_markdown_description')).toBe('true');
  });
  it('refuses a task from another scope or workspace as missing, not as an outage', async () => {
    expect(await mock(route({ space: { id: '11' } })).client.driver(association).getItem('a1')).toMatchObject({ code: 'not_found' });
    expect(await mock(route({ team_id: '901' })).client.driver(association).getItem('a1')).toMatchObject({ code: 'not_found' });
  });
  it('rejects a malformed ID without calling ClickUp', async () => {
    const { client, requests } = mock(() => undefined);
    expect(await client.driver(association).getItem('../team')).toMatchObject({ code: 'not_found' });
    expect(requests).toHaveLength(0);
  });
  it('revalidates on every read rather than renewing a cached snapshot', async () => {
    let reads = 0;
    let revoked = false;
    const { client } = mock(url => url.pathname === '/api/v2/task/a1' ? (revoked ? json({}, 403) : json(task('a1', { name: `Revision ${++reads}` }))) : undefined);
    const driver = client.driver(association);
    expect(await driver.getItem('a1')).toMatchObject({ item: { title: 'Revision 1' } });
    expect(await driver.getItem('a1')).toMatchObject({ item: { title: 'Revision 2' } });
    revoked = true;
    expect(await driver.getItem('a1')).toMatchObject({ code: 'unauthorized' });
  });
});

describe('failures stay distinct and carry no secret', () => {
  it.each([
    [401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [503, 'unavailable'], [400, 'unavailable'],
  ])('maps a list HTTP%s to %s', async (status, code) => {
    const { client } = mock(() => json({ err: 'pk_secret' }, status));
    const result = await client.driver(association).listIssues(list);
    expect(result).toMatchObject({ available: false, code });
    expect(JSON.stringify(result)).not.toContain('pk_secret');
  });
  it('tells an empty list from an unavailable one', async () => {
    expect(await mock(tasksRoute([[]])).client.driver(association).listIssues(list)).toMatchObject({ available: true, items: [] });
    expect(await mock(() => json({ tasks: 'nope' })).client.driver(association).listIssues(list)).toMatchObject({ available: false, code: 'invalid_response' });
  });
  it('cools down from ClickUp\'s reset header and stops calling until it passes', async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 90);
    const { client, requests } = mock(() => json({}, 429, { 'x-ratelimit-reset': reset }));
    const result = await client.driver(association).listIssues(list);
    expect(result).toMatchObject({ code: 'rate_limited' });
    expect(!result.available && result.code === 'rate_limited' && result.retryAfterSeconds).toBeGreaterThanOrEqual(88);
    const before = requests.length;
    await client.driver(association).listIssues({ ...list, refresh: '1' });
    expect(requests).toHaveLength(before);
  });
});

it('forgets the workspace and cached results on clearCache', async () => {
  const { client, requests } = mock(tasksRoute([[task('a1')]]));
  const driver = client.driver(association);
  await driver.listIssues(list);
  await driver.listIssues(list);
  expect(requests).toHaveLength(2);
  client.clearCache();
  await driver.listIssues(list);
  expect(requests).toHaveLength(4);
});

it('offers no mediated task access, so a task can neither read through nor write with the token', () => {
  const { client, requests } = mock(() => undefined);
  const driver = client.driver(association);
  expect(driver.context).toBeUndefined();
  expect(requests).toHaveLength(0);
});
