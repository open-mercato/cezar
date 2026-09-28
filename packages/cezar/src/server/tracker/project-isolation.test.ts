import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createTrackerService } from './index.ts';
import { writeTrackerAssociation } from '../../tracker-association.ts';

let root: string;
let a: string;
let b: string;
const team = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown) => new Response(JSON.stringify({ data: body }));
const pageInfo = { hasNextPage: true, endCursor: 'next' };
const calls: string[] = [];
let defer: (() => Promise<void>) | undefined;
const fetcher: typeof fetch = async (_url, init) => {
  const auth = (init?.headers as Record<string, string>).Authorization!;
  calls.push(auth);
  const query = JSON.parse(String(init?.body)).query as string;
  if (query.includes('TrackerSource')) return json({ organization: { id: 'same-org', urlKey: 'same' } });
  if (defer) await defer();
  if (query.includes('TrackerTeams(')) return json({ teams: { nodes: [{ id: team, name: auth }], pageInfo } });
  if (query.includes('TrackerTeam(')) return json({ team: { id: team, name: auth } });
  const item = { identifier: 'ENG-1', title: auth, description: 'Context', url: 'https://linear.app/same/issue/ENG-1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', creator: null, team: { id: team },
    state: { name: 'Open', type: 'started' }, labels: { nodes: [], pageInfo: { hasNextPage: false } } };
  return query.includes('TrackerIssue(') ? json({ issue: item }) : json({ result: { nodes: [item], pageInfo } });
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tracker-isolation-'));
  a = join(root, 'a'); b = join(root, 'b'); await mkdir(a); await mkdir(b);
  calls.length = 0; defer = undefined;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const service = () => createTrackerService({ CEZ_HOME: join(root, 'home'), JIRA_API_TOKEN: 'ignored', LINEAR_API_KEY: 'ignored' }, fetcher);
const data = (project: string) => join(project, '.ai/cezar');
async function connect(s: ReturnType<typeof service>, project: string) {
  const result = await s.resolve(project, { kind: 'linear', sourceId: 'same-org', externalId: team, connectionId: (await s.connection(project)).connection?.id });
  if (!result.available) throw new Error(result.reason);
  await writeTrackerAssociation(data(project), result.association);
  return result.association;
}
async function driver(s: ReturnType<typeof service>, project: string) {
  const result = await s.driver(project, data(project));
  if ('available' in result) throw new Error(result.reason);
  return result;
}
it('never falls back to global credentials or probes vendors during connection discovery', async () => {
  const s = service();
  expect(await s.connection(a)).toEqual({ connection: null, demo: false });
  expect(await s.candidates(a, { kind: 'linear', limit: 50 })).toMatchObject({ code: 'credentials_missing' });
  expect(calls).toEqual([]);
  const saved = await s.saveConnection(a, { kind: 'linear', key: 'A' });
  expect(saved?.connection?.kind).toBe('linear');
  expect(JSON.stringify(saved)).not.toContain('"key"');
  expect(await s.connection(b)).toMatchObject({ connection: null });
  expect(calls).toEqual([]);
});
it('isolates credentials, cache and cursor namespaces even with identical vendor source/scope IDs', async () => {
  const s = service();
  await s.saveConnection(a, { kind: 'linear', key: 'A' });
  await s.saveConnection(b, { kind: 'linear', key: 'B' });
  const ca = await s.candidates(a, { kind: 'linear', limit: 1 });
  expect(ca).toMatchObject({ candidates: [{ name: 'A' }] });
  expect(await s.candidates(b, { kind: 'linear', limit: 1 })).toMatchObject({ candidates: [{ name: 'B' }] });
  if (!ca.available) throw new Error('Expected candidates');
  expect(await s.candidates(b, { kind: 'linear', limit: 1, cursor: ca.nextCursor })).toMatchObject({ code: 'invalid_cursor' });
  await connect(s, a); await connect(s, b);
  const da = await driver(s, a); const db = await driver(s, b);
  const page = await da.listIssues({ state: 'all', limit: 1 });
  expect(page).toMatchObject({ items: [{ title: 'A' }] });
  expect(await db.listIssues({ state: 'all', limit: 1 })).toMatchObject({ items: [{ title: 'B' }] });
  if (!page.available) throw new Error('Expected page');
  expect(await db.listIssues({ state: 'all', limit: 1, cursor: page.nextCursor })).toMatchObject({ code: 'invalid_cursor' });
  expect(await db.getItem('ENG-1')).toMatchObject({ item: { title: 'B' } });
});
it('fails closed after key replacement, copied association, deletion and cross-process changes', async () => {
  const s = service();
  await s.saveConnection(a, { kind: 'linear', key: 'A' });
  await s.saveConnection(b, { kind: 'linear', key: 'B' });
  const association = await connect(s, a);
  await writeTrackerAssociation(data(b), association);
  expect(await s.driver(b, data(b))).toMatchObject({ code: 'source_changed' });
  const old = await driver(s, a);
  const otherServer = service();
  await otherServer.saveConnection(a, { kind: 'linear', key: 'new-A' });
  expect(await s.driver(a, data(a))).toMatchObject({ code: 'source_changed' });
  expect(await s.resolve(a, { kind: 'linear', sourceId: 'same-org', externalId: team, connectionId: association.connectionId })).toMatchObject({ code: 'source_changed' });
  const before = calls.length;
  expect(await old.getItem('ENG-1')).toMatchObject({ code: 'source_changed' });
  expect(calls).toHaveLength(before);
  await connect(s, a);
  expect(await (await driver(s, a)).getItem('ENG-1')).toMatchObject({ item: { title: 'new-A' } });
  await otherServer.removeConnection(a);
  expect(await s.driver(a, data(a))).toMatchObject({ code: 'credentials_missing' });
  expect(await s.connection(b)).toMatchObject({ connection: { kind: 'linear' } });
});
it('does not release an in-flight result after credentials are removed', async () => {
  const s = service(); await s.saveConnection(a, { kind: 'linear', key: 'A' }); await connect(s, a);
  const d = await driver(s, a);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = vi.fn();
  defer = () => { entered(); return pending; };
  const read = d.getItem('ENG-1');
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  await s.removeConnection(a); release();
  expect(await read).toMatchObject({ available: false, code: 'source_changed' });
});

it('keeps dry-run fixtures independent from real saved credentials', async () => {
  const s = service(); await s.saveConnection(a, { kind: 'linear', key: 'private-A' });
  const demo = createTrackerService({ CEZ_HOME: join(root, 'home'), CEZ_DRY_RUN: '1' }, fetcher);
  expect(await demo.connection(a)).toEqual({ connection: null, demo: true });
  expect(await demo.removeConnection(a)).toBe(false);
  expect(await demo.saveConnection(a, { kind: 'linear', key: 'replacement' })).toBeNull();
  expect(await demo.candidates(a, { kind: 'linear', limit: 1 })).toMatchObject({ available: true });
  expect(calls).toEqual([]);
  expect(await s.connection(a)).toMatchObject({ connection: { kind: 'linear' } });
});

it('blocks cached providers and late results after a manual env edit with unchanged UUID', async () => {
  const s = service(); await s.saveConnection(a, { kind: 'linear', key: 'before-edit' }); await connect(s, a);
  const d = await driver(s, a);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = vi.fn(); defer = () => { entered(); return pending; };
  const read = d.getItem('ENG-1');
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  const directory = join(root, 'home', 'tracker-connections');
  const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.env'))!);
  await writeFile(file, (await readFile(file, 'utf8')).replace('before-edit', 'after-edit'));
  release();
  expect(await read).toMatchObject({ code: 'source_changed' });
  const before = calls.length;
  expect(await d.getItem('ENG-1')).toMatchObject({ code: 'source_changed' });
  expect(calls).toHaveLength(before);
  expect(await s.connection(a)).toMatchObject({ connection: null });
});

it.each(['list', 'search', 'detail'].flatMap(operation => ['disconnect', 'reassociate'].map(mutation => [operation, mutation])))('rejects late %s responses after %s', async (operation, mutation) => {
  const s = service(); await s.saveConnection(a, { kind: 'linear', key: 'A' }); await connect(s, a);
  const d = await driver(s, a);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = vi.fn(); defer = () => { entered(); return pending; };
  const read = operation === 'detail' ? d.getItem('ENG-1') : operation === 'search'
    ? d.searchItems({ q: 'test', state: 'all', limit: 1 }) : d.listIssues({ state: 'all', limit: 1 });
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  if (mutation === 'disconnect') await rm(join(data(a), 'tracker.json'));
  else {
    const association = d.association;
    await writeTrackerAssociation(data(a), { ...association, externalId: 'another-team' });
  }
  release();
  expect(await read).toMatchObject({ available: false, code: 'source_changed' });
  const before = calls.length;
  expect(await d.getItem('ENG-1')).toMatchObject({ code: 'source_changed' });
  expect(calls).toHaveLength(before);
});
