import { describe, it, expect, vi } from 'vitest';
import { createLinearClient } from './linear.ts';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';

const teamId = '11111111-1111-4111-8111-111111111111';
const association: TrackerAssociation = { kind: 'linear', source: { id: 'org-1', webUrl: 'https://linear.app/acme' }, externalId: teamId, externalName: 'Engineering' };
const pageInfo = { hasNextPage: false, endCursor: null };
const issue = (over: Record<string, unknown> = {}) => ({
  identifier: 'ENG-1', title: 'Fix', description: 'Full detail', creator: { name: 'Ada' },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  labels: { nodes: [{ name: 'backend' }], pageInfo: { hasNextPage: false } },
  state: { name: 'Started', type: 'started' }, team: { id: teamId },
  url: 'https://linear.app/acme/issue/ENG-1/fix', ...over,
});
const json = (data: unknown, status = 200, headers: RequestInit['headers'] = {}) => new Response(JSON.stringify(data), { status, headers });
function mock(read: (query: string, variables: Record<string, unknown>) => Response | Promise<Response>) {
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    requests.push(req);
    expect(init?.headers).toMatchObject({ Authorization: 'linear-secret' });
    if (req.query.includes('TrackerSource')) return json({ data: { organization: { id: 'org-1', urlKey: 'acme' } } });
    return read(req.query, req.variables);
  }) as unknown as typeof fetch;
  return { client: createLinearClient({ key: 'linear-secret' }, fetcher), requests, fetcher };
}
describe('Linear read-only adapter', () => {
  it('discovers/searches/paginates teams with variables and validates a direct canonical selection', async () => {
    const { client, requests } = mock((query, vars) => query.includes('TrackerTeam(')
      ? json({ data: { team: { id: teamId, name: 'Renamed Engineering' } } })
      : json({ data: { teams: { nodes: [{ id: teamId, name: 'Engineering' }], pageInfo: vars.after ? pageInfo : { hasNextPage: true, endCursor: 'cursor-1' } } } }));
    const first = await client.listCandidates({ kind: 'linear', q: 'ENG"unsafe', limit: 1 });
    expect(first).toMatchObject({ available: true, truncated: true });
    if (!first.available) return;
    await client.listCandidates({ kind: 'linear', q: 'ENG"unsafe', limit: 1, cursor: first.nextCursor });
    expect(requests[1]?.variables.filter).toEqual({ or: [{ name: { containsIgnoreCase: 'ENG"unsafe' } }, { key: { containsIgnoreCase: 'ENG"unsafe' } }] });
    expect(requests[2]?.variables.after).toBe('cursor-1');
    expect(await client.resolveAssociation({ kind: 'linear', sourceId: 'org-1', externalId: teamId }))
      .toMatchObject({ available: true, association: { externalName: 'Renamed Engineering' } });
  });
  it('uses team filter (not team boost), all label constraints, state and ordered paginated vendor search', async () => {
    const { client, requests } = mock(() => json({ data: { result: { nodes: [issue()], pageInfo } } }));
    expect(await client.driver(association).searchItems({ q: 'ENG-123', state: 'active', limit: 50, labels: ['a', 'b'] }))
      .toMatchObject({ available: true, items: [{ id: 'ENG-1' }] });
    const req = requests[1]!;
    expect(req.query).toContain('searchIssues');
    expect(req.query).toContain('orderBy: updatedAt');
    expect(req.variables).toMatchObject({ term: 'ENG-123', filter: { team: { id: { eq: teamId } }, state: { type: { nin: ['completed', 'canceled'] } }, and: [{ labels: { some: { name: { eq: 'a' } } } }, { labels: { some: { name: { eq: 'b' } } } }] } });
  });
  it('rejects changed organization before fetching a ticket and enforces direct team scope', async () => {
    const { client, requests } = mock(() => json({ data: { issue: issue({ team: { id: 'other' } }) } }));
    expect(await client.driver({ ...association, source: { ...association.source, id: 'other' } }).getItem('ENG-1')).toMatchObject({ code: 'source_changed' });
    expect(requests).toHaveLength(1);
    expect(await client.driver(association).getItem('ENG-1')).toMatchObject({ code: 'not_found' });
  });
  it.each([200, 400])('rejects GraphQL partial data and honours RATELIMITED at HTTP%s', async status => {
    const { client, requests } = mock(() => json({ data: { result: { nodes: [issue()], pageInfo } }, errors: [{ message: 'linear-secret', extensions: { code: 'RATELIMITED' } }] }, status, { 'x-ratelimit-requests-reset': String(Date.now() + 90_000) }));
    const result = await client.driver(association).listIssues({ state: 'all', limit: 50 });
    expect(result).toMatchObject({ code: 'rate_limited' });
    if (result.available || result.code !== 'rate_limited') return;
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(89);
    expect(JSON.stringify(result)).not.toContain('linear-secret');
    await client.driver(association).listIssues({ state: 'all', limit: 50, refresh: '1' });
    expect(requests).toHaveLength(2);
  });
  it('rejects all partial errors even with required data present', async () => {
    const { client } = mock(() => json({ data: { result: { nodes: [issue()], pageInfo } }, errors: [{ message: 'secret backend exception' }] }));
    expect(await client.driver(association).listIssues({ state: 'all', limit: 50 })).toMatchObject({ available: false, code: 'unavailable' });
  });
  it('caps bodies independently, preserves canonical ID and rejects unsafe web URLs', async () => {
    let unsafe = false;
    const { client } = mock(query => query.includes('TrackerIssue(')
      ? json({ data: { issue: issue({ description: 'x'.repeat(61_000), ...(unsafe ? { url: 'https://evil.test/issue' } : {}) }) } })
      : json({ data: { result: { nodes: [issue({ description: 'x'.repeat(61_000) })], pageInfo } } }));
    const driver = client.driver(association);
    const list = await driver.listIssues({ state: 'all', limit: 50 });
    expect(list.available && list.items[0]?.body.length).toBe(8000);
    const detail = await driver.getItem('OLD-1');
    expect(detail.available && detail.item.body.length).toBe(60000);
    expect(detail.available && detail.item.bodyTruncated).toBe(true);
    client.clearCache(); unsafe = true;
    expect(await driver.getItem('ENG-1')).toMatchObject({ code: 'invalid_response' });
  });
  it('binds cursors to team and filters and rejects incomplete continuation', async () => {
    let incomplete = false;
    const { client } = mock(() => json({ data: { result: { nodes: [issue()], pageInfo: { hasNextPage: true, endCursor: incomplete ? null : 'next' } } } }));
    const first = await client.driver(association).listIssues({ state: 'all', limit: 50 });
    if (!first.available) throw new Error('fixture failed');
    expect(await client.driver(association).listIssues({ state: 'active', limit: 50, cursor: first.nextCursor })).toMatchObject({ code: 'invalid_cursor' });
    incomplete = true;
    expect(await client.driver(association).listIssues({ state: 'all', limit: 50, refresh: '1' })).toMatchObject({ code: 'invalid_response' });
  });
  it.each([401, 403, 404, 429, 503])('maps HTTP%s after discovery without exposing token', async status => {
    const { client } = mock(() => json({ message: 'linear-secret' }, status));
    const result = await client.driver(association).getItem('ENG-1');
    expect(result).toMatchObject({ available: false, code: status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status === 503 ? 'unavailable' : 'unauthorized' });
    expect(JSON.stringify(result)).not.toContain('linear-secret');
  });
});


it('uses only exhausted reset windows for rate-limit cooldown', async () => {
  const { client } = mock(() => json({ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 400, {
    'x-ratelimit-requests-reset': String(Date.now() + 3_600_000),
    'x-ratelimit-requests-remaining': '1000',
    'x-ratelimit-endpoint-requests-reset': String(Date.now() + 30_000),
    'x-ratelimit-endpoint-requests-remaining': '0',
  }));
  const result = await client.driver(association).listIssues({ state: 'all', limit: 100 });
  expect(result).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
});
it('keeps maximum-page nested labels below the query complexity ceiling', async () => {
  const { client, requests } = mock(() => json({ data: { result: { nodes: [], pageInfo } } }));
  await client.driver(association).listIssues({ state: 'all', limit: 100 });
  expect(requests[1]?.query).toContain('labels(first: 50)');
});

it('never accepts success-shaped data carried by HTTP400', async () => {
  const { client } = mock(() => json({ data: { result: { nodes: [issue()], pageInfo } } }, 400));
  expect(await client.driver(association).listIssues({ state: 'all', limit: 50 })).toMatchObject({ code: 'invalid_response' });
});

it('revalidates detail on a subsequent request instead of renewing a cached snapshot', async () => {
  let reads = 0;
  let revoked = false;
  const { client } = mock(() => revoked ? json({}, 403) : json({ data: { issue: issue({ title: `Revision ${++reads}` }) } }));
  const driver = client.driver(association);
  const initial = await Promise.all([driver.getItem('ENG-1'), driver.getItem('ENG-1')]);
  for (const result of initial) expect(result).toMatchObject({ available: true, item: { title: 'Revision 1' } });
  expect(reads).toBe(1);
  expect(await driver.getItem('ENG-1')).toMatchObject({ available: true, item: { title: 'Revision 2' } });
  revoked = true;
  expect(await driver.getItem('ENG-1')).toMatchObject({ available: false, code: 'unauthorized' });
});
