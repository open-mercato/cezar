import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  trackerCandidatesResponseSchema, trackerAssociationResponseSchema, trackerItemsResponseSchema,
  trackerItemResponseSchema, trackerChangedEventSchema,
} from '@open-mercato/cezar-contract';
import { registerProject } from '../workspace/projects.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, WorkspaceEventBus } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

// Tracker credential isolation must not depend on installed agent CLI startup times.
// Keep the real health/tracker routes and no-network assertions; backend probing has its own suite.
vi.mock('../core/backend-detect.ts', () => ({ detectEnvironment: async () => [] }));

describe('tracker API boundaries and isolation', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-tracker-api-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => { store.flush(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
  const app = (workspaceEvents?: WorkspaceEventBus) => createApp({
    repoRoot: root, store, manager: {} as RunManager, version: 'test', workspaceEvents,
  });
  const put = (body: unknown): RequestInit => ({
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const selection = { kind: 'jira', sourceId: 'dry-jira', externalId: '51' };

  it('registers watches without fetching pages and scopes handles to the project', async () => {
    const instance = app();
    const connected = await (await apiRequest(instance, '/api/v1/tracker/association', put(selection))).json() as { association: unknown };
    const opened = await apiRequest(instance, '/api/v1/tracker/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ association: connected.association, query: '', state: 'active', labels: [] }) });
    expect(opened.status).toBe(200);
    const handle = await opened.json() as { id: string; topic: string };
    expect(handle.topic).toBe(`tracker:${handle.id}`);
    const path = `/api/v1/p/default/tracker/watch/${handle.id}`;
    const otherRoot = join(root, 'other-project');
    mkdirSync(otherRoot);
    const other = await registerProject(otherRoot);
    expect((await apiRequest(instance, `/api/v1/p/${other.id}/tracker/watch/${handle.id}`)).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/tracker/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"state":"nonsense"}' })).status).toBe(400);
    expect(await (await apiRequest(instance, path)).json()).toMatchObject({ checkedAt: null, checking: false, result: null });
    expect(await (await apiRequest(instance, path, { method: 'POST' })).json()).toMatchObject({ result: { available: true }, checking: false });
    await apiRequest(instance, '/api/v1/tracker/association', { method: 'DELETE' });
    expect(await (await apiRequest(instance, path)).json()).toMatchObject({ checkedAt: null, result: { code: 'source_changed' } });
    expect((await apiRequest(instance, '/api/v1/tracker/watch/not-a-uuid')).status).toBe(400);
  });

  it.each([false, true])('classifies registered and single-project boot scopes (single=%s)', async single => {
    await registerProject(root);
    vi.stubEnv('CEZ_SINGLE_PROJECT', single ? '1' : '0');
    const instance = app();
    expect((await apiRequest(instance, '/api/v1/p/default/tracker/association', put(selection))).status).toBe(200);
    const projects = await (await apiRequest(instance, '/api/v1/projects')).json() as { projects: Array<{ tracker?: string; unregistered?: boolean }> };
    expect(projects.projects[0]).toMatchObject({ tracker: 'jira' });
    expect(projects.projects[0]?.unregistered).toBeUndefined();
    await apiRequest(instance, '/api/v1/p/default/tracker/association', { method: 'DELETE' });
    const cleared = await (await apiRequest(instance, '/api/v1/projects')).json() as { projects: Array<{ tracker?: string }> };
    expect(cleared.projects[0]?.tracker).toBeUndefined();
  });

  it('ignores legacy server credentials and never probes vendors before project configuration', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('JIRA_BASE_URL', 'https://acme.atlassian.net');
    vi.stubEnv('JIRA_EMAIL', 'test@example.com');
    vi.stubEnv('JIRA_API_TOKEN', 'test-token');
    vi.stubEnv('LINEAR_API_KEY', 'test-key');
    const fetcher = vi.fn(() => { throw new Error('prohibited network'); });
    vi.stubGlobal('fetch', fetcher);
    const instance = app();
    const health = await (await apiRequest(instance, '/api/v1/health')).json();
    expect(health).not.toHaveProperty('capabilities.trackerJira');
    expect(health).not.toHaveProperty('capabilities.trackerLinear');
    await apiRequest(instance, '/api/v1/projects');
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv('JIRA_API_TOKEN', '');
    expect(await (await apiRequest(instance, '/api/v1/health')).json()).not.toHaveProperty('capabilities.trackerJira');
    expect(await (await apiRequest(instance, '/api/v1/tracker/candidates?kind=jira')).json()).toMatchObject({ code: 'credentials_missing' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('paginates project discovery, connects a canonical selection beyond first page and dual-mounts reads', async () => {
    const instance = app();
    const first = trackerCandidatesResponseSchema.parse(await (await apiRequest(instance, '/api/v1/tracker/candidates?kind=jira')).json());
    expect(first.available).toBe(true);
    if (!first.available) return;
    expect(first.candidates).toHaveLength(50);
    expect(first.truncated).toBe(true);
    const second = trackerCandidatesResponseSchema.parse(await (await apiRequest(instance, '/api/v1/tracker/candidates?kind=jira&cursor=' + first.nextCursor)).json());
    expect(second.available && second.candidates[0]).toMatchObject({ id: '51' });
    const connected = await apiRequest(instance, '/api/v1/tracker/association', put(selection));
    expect(connected.status).toBe(200);
    expect(trackerAssociationResponseSchema.parse(await connected.json()).association).toMatchObject(selection.kind === 'jira' ? { kind: 'jira', externalId: '51' } : {});
    const boot = (await (await apiRequest(instance, '/api/v1/projects')).json() as { bootProject: string }).bootProject;
    const urls = ['/api/v1', '/api/v1/p/default', '/api/v1/p/' + boot];
    const answers = await Promise.all(urls.map(async base => (await apiRequest(instance, base + '/tracker')).json()));
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toEqual(answers[2]);
    expect(trackerItemsResponseSchema.parse(answers[0])).toMatchObject({ available: true, truncated: true });
    const detail = await apiRequest(instance, '/api/v1/p/default/tracker/DEMO51-2');
    expect(detail.status).toBe(200);
    const body = trackerItemResponseSchema.parse(await detail.json());
    expect(body.available && body.item.body.length).toBeGreaterThan(8000);
    expect((await apiRequest(instance, '/api/v1/tracker/DEMO52-2')).status).toBe(404);
  });

  it('keeps static routes reserved and rejects invalid middleware inputs', async () => {
    const instance = app();
    for (const url of [
      '/api/v1/tracker?limit=101', '/api/v1/tracker?labels=no',
      '/api/v1/tracker/search?q=', '/api/v1/tracker/candidates?kind=github',
    ]) expect((await apiRequest(instance, url)).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/tracker/association', put({ ...selection, externalName: 'forged' }))).status).toBe(400);
    expect((await apiRequest(instance, '/api/v1/tracker/association', put({ ...selection, sourceId: 'other' }))).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/tracker/association', put({ ...selection, externalId: '999' }))).status).toBe(404);
    expect(await (await apiRequest(instance, '/api/v1/tracker')).json()).toMatchObject({ code: 'not_configured' });
  });

  it('preserves saved connection on failed replacement, emits only successful changes, disconnects offline', async () => {
    const bus = new WorkspaceEventBus();
    const events: unknown[] = [];
    bus.on((name, payload) => { if (name === 'tracker-changed') events.push(trackerChangedEventSchema.parse(payload)); });
    const instance = app(bus);
    await apiRequest(instance, '/api/v1/tracker/association', put(selection));
    const saved = readFileSync(join(root, '.ai/cezar/tracker.json'), 'utf8');
    await apiRequest(instance, '/api/v1/tracker/association', put({ ...selection, sourceId: 'wrong' }));
    expect(readFileSync(join(root, '.ai/cezar/tracker.json'), 'utf8')).toBe(saved);
    expect(events).toHaveLength(1);
    vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('JIRA_API_TOKEN', '');
    const offline = app(bus);
    const fetcher = vi.fn(() => { throw new Error('network prohibited'); });
    vi.stubGlobal('fetch', fetcher);
    expect(await (await apiRequest(offline, '/api/v1/tracker')).json()).toMatchObject({ code: 'credentials_missing' });
    expect(await (await apiRequest(offline, '/api/v1/tracker/association')).json()).toHaveProperty('association.kind', 'jira');
    const projects = await (await apiRequest(offline, '/api/v1/projects')).json() as { projects: unknown[] };
    expect(projects.projects[0]).not.toHaveProperty('tracker');
    expect((await apiRequest(offline, '/api/v1/tracker/association', { method: 'DELETE' })).status).toBe(200);
    expect((await apiRequest(offline, '/api/v1/tracker/association', { method: 'DELETE' })).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect(events).toHaveLength(3);
  });

  it('reports persistence failures and keeps old state', async () => {
    const instance = app();
    await apiRequest(instance, '/api/v1/tracker/association', put(selection));
    // A directory at the atomic destination reliably fails even when tests run as root.
    rmSync(join(root, '.ai/cezar/tracker.json'));
    mkdirSync(join(root, '.ai/cezar/tracker.json'));
    writeFileSync(join(root, '.ai/cezar/tracker.json/keep'), 'keep');
    expect((await apiRequest(instance, '/api/v1/tracker/association', put(selection))).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/tracker/association', { method: 'DELETE' })).status).toBe(409);
  });

  it('invalidates cursors on association switch and scopes search', async () => {
    const instance = app();
    await apiRequest(instance, '/api/v1/tracker/association', put(selection));
    const page = await (await apiRequest(instance, '/api/v1/tracker?state=all')).json() as { nextCursor: string };
    await apiRequest(instance, '/api/v1/tracker/association', put({ kind: 'linear', sourceId: 'dry-linear', externalId: '51' }));
    expect((await apiRequest(instance, '/api/v1/tracker?state=all&cursor=' + page.nextCursor)).status).toBe(400);
    expect(await (await apiRequest(instance, '/api/v1/tracker/search?q=ENG51-125')).json()).toMatchObject({ available: true, items: [{ id: 'ENG51-125' }] });
    expect(await (await apiRequest(instance, '/api/v1/tracker/search?q=DEMO51-125')).json()).toMatchObject({ available: true, items: [] });
  });
});

it('keeps credential HTTP responses write-only and aliases connection routes to the boot project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-credentials-api-'));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  const store = RunStore.open(join(root, '.ai/cezar'));
  const fetcher = vi.fn(() => { throw new Error('No vendor access during credential storage'); });
  vi.stubGlobal('fetch', fetcher);
  try {
    const instance = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    const secret = 'test-private-token-never-in-response';
    const write = (body: unknown) => apiRequest(instance, '/api/v1/p/default/tracker/connection', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const saved = await write({ kind: 'linear', key: secret });
    expect(saved.status).toBe(200);
    const body = await saved.json() as { connection: { id: string } };
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body).toMatchObject({ connection: { kind: 'linear' }, demo: false });
    const alias = await (await apiRequest(instance, '/api/v1/tracker/connection')).json();
    expect(alias).toEqual(body);
    expect((await write({ kind: 'linear', key: '' })).status).toBe(400);
    expect(await (await apiRequest(instance, '/api/v1/tracker/connection')).json()).toEqual(body);
    expect((await apiRequest(instance, '/api/v1/p/unknown/tracker/connection')).status).toBe(404);
    expect((await apiRequest(instance, '/api/v1/tracker/connection', { method: 'DELETE' })).status).toBe(200);
    expect(await (await apiRequest(instance, '/api/v1/tracker/connection')).json()).toEqual({ connection: null, demo: false });
    expect(fetcher).not.toHaveBeenCalled();
  } finally { store.flush(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); }
});

// Spec 2026-11-18-shared-tracker-connections.
it('shares credentials across projects only after an explicit pick, without exposing secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-shared-api-'));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  const store = RunStore.open(join(root, '.ai/cezar'));
  const fetcher = vi.fn(() => { throw new Error('No vendor access during credential storage'); });
  vi.stubGlobal('fetch', fetcher);
  try {
    const instance = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    const otherRoot = join(root, 'other-project');
    mkdirSync(otherRoot);
    const other = await registerProject(otherRoot);
    const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const token = 'shared-api-token-never-in-response';
    // Absent `shared` keeps today's project-only save.
    const own = await (await apiRequest(instance, '/api/v1/tracker/connection', json('PUT', { kind: 'linear', key: 'own-key' }))).json() as { connection: { id: string; shared?: true } };
    expect(own.connection).not.toHaveProperty('shared');
    expect(await (await apiRequest(instance, '/api/v1/tracker/connection/shared')).json()).toEqual({ connections: [], demo: false });
    const saved = await apiRequest(instance, '/api/v1/tracker/connection', json('PUT', { kind: 'jira', origin: 'https://acme.atlassian.net', email: 'dev@acme.test', token, shared: true }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ connection: { kind: 'jira', shared: true }, demo: false });
    const listed = await (await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection/shared`)).json() as { connections: Array<{ id: string; label: string; current: boolean }> };
    expect(listed.connections).toEqual([{ id: expect.any(String), kind: 'jira', label: expect.stringMatching(/^acme\.atlassian\.net — d…@acme\.test · [0-9a-f]{4}$/), createdAt: expect.any(String), current: false }]);
    expect(JSON.stringify(listed)).not.toMatch(/shared-api-token|dev@acme/);
    // The other project has nothing until it picks the shared connection.
    expect(await (await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection`)).json()).toEqual({ connection: null, demo: false });
    const sharedId = listed.connections[0]!.id;
    expect((await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection/shared`, json('PUT', { id: '00000000-0000-4000-8000-000000000000' }))).status).toBe(404);
    expect((await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection/shared`, json('PUT', { id: 'nope' }))).status).toBe(400);
    const linked = await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection/shared`, json('PUT', { id: sharedId }));
    expect(linked.status).toBe(200);
    const linkedBody = await linked.json() as { connection: { id: string } };
    expect(linkedBody).toMatchObject({ connection: { kind: 'jira', shared: true } });
    expect(JSON.stringify(linkedBody)).not.toContain(token);
    expect((await (await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection/shared`)).json() as typeof listed).connections[0]!.current).toBe(true);
    // DELETE on a linked project only unlinks it.
    expect((await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection`, { method: 'DELETE' })).status).toBe(200);
    expect(await (await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection`)).json()).toEqual({ connection: null, demo: false });
    expect((await (await apiRequest(instance, '/api/v1/tracker/connection/shared')).json() as typeof listed).connections).toHaveLength(1);
    // Promote: a project's own record becomes shared and keeps its revision.
    const otherOwn = await (await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection`, json('PUT', { kind: 'linear', key: 'other-key' }))).json() as { connection: { id: string } };
    const promoted = await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection/promote`, { method: 'POST' });
    expect(await promoted.json()).toEqual({ connection: { id: otherOwn.connection.id, kind: 'linear', shared: true }, demo: false });
    expect((await apiRequest(instance, `/api/v1/p/${other.id}/tracker/connection/promote`, { method: 'POST' })).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  } finally { store.flush(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); }
});

it('answers the shared-connection routes without credentials in demo mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tracker-shared-demo-'));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  const store = RunStore.open(join(root, '.ai/cezar'));
  try {
    const instance = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
    expect(await (await apiRequest(instance, '/api/v1/tracker/connection/shared')).json()).toEqual({ connections: [], demo: true });
    expect((await apiRequest(instance, '/api/v1/tracker/connection/promote', { method: 'POST' })).status).toBe(409);
    expect((await apiRequest(instance, '/api/v1/tracker/connection/shared', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000000' }) })).status).toBe(409);
  } finally { store.flush(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
