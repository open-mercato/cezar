import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { delimiter, join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagerMessage } from '@open-mercato/cezar-contract';
import { agentProfileResponseSchema, runnerSchema } from '@open-mercato/cezar-contract';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import type { AgentEvent } from '../core/agent-runner.ts';
import type { ManagerEngine } from '../managers/engine.ts';
import type { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { eligibleFallbackCandidates, fallbackConsentCurrent, managerFallbackPolicy } from '../workspace/agent-fallback.ts';
import { ManagerStore } from '../managers/store.ts';
import { RunStore } from '../runs/store.ts';
import { track } from '../telemetry.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, WorkspaceEventBus } from './server.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1' };
const BASE = '/api/v1/workspace/managers';
const managerStore = () => new ManagerStore(() => undefined);

describe('the managers routes', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  let engine: ManagerEngine;
  let startRun: ReturnType<typeof vi.fn>;
  let switchAgent: ReturnType<typeof vi.fn>;
  let bus: WorkspaceEventBus;
  let app: ReturnType<typeof createApp>;
  const saved = { CEZ_HOME: process.env.CEZ_HOME, CEZ_DRY_RUN: process.env.CEZ_DRY_RUN, CEZ_MANAGERS: process.env.CEZ_MANAGERS };

  const request = (path: string, init?: { method?: string; body?: unknown }) => app.request(path, {
    method: init?.method ?? 'GET',
    headers: JSON_HEADERS,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const createManager = async (body: unknown = { instructions: 'Watch', projects: 'all' }) => {
    const response = await request(BASE, { method: 'POST', body });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; connectedProjectIds: string[] };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-managers-api-'));
    home = mkdtempSync(join(tmpdir(), 'cez-managers-home-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MANAGERS;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    startRun = vi.fn(() => ({ id: 'run-1' }));
    switchAgent = vi.fn(() => ({ summary: 'Switched task agent' }));
    bus = new WorkspaceEventBus();
    app = createApp({
      repoRoot: root,
      version: 'test',
      store,
      manager: { startRun, switchAgent, isActive: () => false } as unknown as RunManager,
      workspaceEvents: bus,
      onManagerEngine: (built) => { engine = built; },
    });
  });

  afterEach(async () => {
    await engine.shutdown();
    store.flush();
    Object.assign(process.env, saved);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('answers 409 on every route, reads included, under CEZ_MANAGERS=0', async () => {
    process.env.CEZ_MANAGERS = '0';
    for (const [method, path] of [['GET', BASE], ['POST', BASE], ['GET', `${BASE}/x`], ['POST', `${BASE}/x/messages`], ['POST', `${BASE}/x/actions/a/decision`]] as const) {
      const response = await request(path, { method, ...(method === 'POST' ? { body: {} } : {}) });
      expect(response.status, path).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain('CEZ_MANAGERS');
    }
  });

  it('keys the cockpit\'s manager events to its device, with closed labels only', async () => {
    const sid = '0192f0e0-0000-7000-8000-000000000000';
    const headers = { ...JSON_HEADERS, 'x-cezar-sid': sid };
    vi.mocked(track).mockClear();
    const created = await app.request(BASE, { method: 'POST', headers, body: JSON.stringify({ name: 'Acme secret', instructions: 'Watch acme', projects: 'all', cronMinutes: 0 }) });
    const { id } = (await created.json()) as { id: string };
    await app.request(`${BASE}/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ cronMinutes: 60 }) });
    await app.request(`${BASE}/${id}`, { method: 'DELETE', headers });
    const calls = vi.mocked(track).mock.calls.filter(([event]) => event.startsWith('manager_'));
    expect(calls).toEqual([
      ['manager_created', { label: 'yes:all:off:default' }, { sid }],
      ['manager_settings_changed', { label: 'watch' }, { sid }],
      ['manager_deleted', { label: '0' }, { sid }],
    ]);
  });

  it('leaves every other route alone under CEZ_MANAGERS=0', async () => {
    process.env.CEZ_MANAGERS = '0';
    expect((await request('/api/v1/health')).status).toBe(200);
    expect((await request('/api/v1/runs')).status).toBe(200);
  });

  it('says how many attachments it kept, and refuses a key it does not know', async () => {
    const { id } = await createManager({ instructions: '', projects: 'all', cronMinutes: 0 });
    const path = `${BASE}/${id}/messages`;
    const sent = await request(path, { method: 'POST', body: { text: 'look', images: [{ mediaType: 'image/png', data: 'aGk=', name: 'a.png' }] } });
    expect(await sent.json()).toEqual({ ok: true, attachments: 1 });
    expect((await request(path, { method: 'POST', body: { text: 'look', pictures: [] } })).status).toBe(400);
  });

  it('validates as middleware and 404s an unknown manager', async () => {
    expect((await request(BASE, { method: 'POST', body: { totalNonsense: 1 } })).status).toBe(400);
    expect((await request(`${BASE}/NOT VALID`)).status).toBe(400);
    expect((await request(BASE, { method: 'POST', body: { instructions: 'x', projects: 'all', model: 'm'.repeat(201) } })).status).toBe(400);
    expect((await request(`${BASE}/missing`)).status).toBe(404);
    expect((await request(`${BASE}/missing/messages`)).status).toBe(404);
    expect((await request(`${BASE}/missing/check`, { method: 'POST' })).status).toBe(404);
  });

  it('writes memory only with its writer named, and lists it (spec 2026-11-21 § 2.1)', async () => {
    const { id } = await createManager();
    expect((await request(`${BASE}/${id}/memory/full-prs`, { method: 'PUT', body: { kind: 'feedback', text: 'Open full PRs' } })).status).toBe(400);
    const saved = await request(`${BASE}/${id}/memory/full-prs`, { method: 'PUT', body: { kind: 'feedback', text: 'Open full PRs', source: 'manager' } });
    expect(await saved.json()).toMatchObject({ entries: [{ key: 'full-prs', source: 'manager' }], limits: { entries: 40, bytes: 6144 } });
    expect(await (await request(`${BASE}/${id}/memory`)).json()).toMatchObject({ entries: [{ key: 'full-prs' }] });
    expect((await request(`${BASE}/${id}/memory/Bad Key`, { method: 'PUT', body: { kind: 'feedback', text: 'x', source: 'user' } })).status).toBe(400);
    expect((await request(`${BASE}/${id}/memory/nope`, { method: 'DELETE' })).status).toBe(404);
  });

  it('persists connector grants and discovers connectors with a dry-run probe', async () => {
    const CAL = 'claude_ai_Google_Calendar';
    const { id } = await createManager({ instructions: 'Calendar', projects: 'all', cronMinutes: 0, connectors: { [CAL]: { level: 'read' } } });
    expect(await (await request(`${BASE}/${id}/connectors`)).json()).toEqual({ available: true, servers: [] });
    const refreshed = await request(`${BASE}/${id}/connectors/refresh`, { method: 'POST' });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      available: true,
      observedAt: expect.any(String),
      servers: [{ key: CAL, name: 'claude.ai Google Calendar', status: 'connected', tools: [
        { name: 'list_events', kind: 'read', mode: 'allow' },
        { name: 'create_event', kind: 'write', mode: 'deny' },
      ] }],
    });
    const patched = await request(`${BASE}/${id}`, { method: 'PATCH', body: { connectors: { [CAL]: { level: 'write', tools: { create_event: 'allow' } } } } });
    expect(await patched.json()).toMatchObject({ connectors: { [CAL]: { level: 'write', tools: { create_event: 'allow' } } } });
    const listed = (await (await request(`${BASE}/${id}/connectors`)).json()) as { servers: Array<{ tools: Array<{ mode: string }> }> };
    expect(listed.servers[0]?.tools.map((tool) => tool.mode)).toEqual(['allow', 'allow']);
    expect((await request(`${BASE}/missing/connectors`)).status).toBe(404);
    expect((await request(`${BASE}/missing/connectors/refresh`, { method: 'POST' })).status).toBe(404);
    expect((await request(`${BASE}/${id}`, { method: 'PATCH', body: { connectors: { 'bad key!': { level: 'read' } } } })).status).toBe(400);
  });

  it('creates, lists, updates and deletes, emitting manager-change', async () => {
    const events: string[] = [];
    bus.on((event) => { events.push(event); });
    const { id, connectedProjectIds } = await createManager();
    expect(connectedProjectIds).toHaveLength(1);

    const list = (await (await request(BASE)).json()) as { managers: Array<{ id: string; cronMinutes: number }> };
    expect(list.managers).toMatchObject([{ id, cronMinutes: 15 }]);

    const patched = await request(`${BASE}/${id}`, { method: 'PATCH', body: { name: 'Ops', cronMinutes: 0 } });
    expect(await patched.json()).toMatchObject({ name: 'Ops', cronMinutes: 0 });
    expect(((await (await request(`${BASE}/${id}`)).json()) as { nextCheckAt?: string }).nextCheckAt).toBeUndefined();

    expect(await (await request(`${BASE}/${id}`, { method: 'DELETE' })).json()).toEqual({ ok: true });
    expect((await request(`${BASE}/${id}`)).status).toBe(404);
    expect(events.filter((event) => event === 'manager-change').length).toBeGreaterThanOrEqual(3);
  });

  it('is workspace-level: no project-scoped spelling', async () => {
    expect((await request('/api/v1/p/default/workspace/managers')).status).toBe(404);
  });

  it('starts a task through the real POST /runs, in process', async () => {
    const { id } = await createManager();
    const [projectId] = ((await (await request(`${BASE}/${id}`)).json()) as { connectedProjectIds: string[] }).connectedProjectIds;
    const response = await request(`${BASE}/${id}/tasks`, { method: 'POST', body: { projectId, task: 'Fix the login' } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ projectId, runId: 'run-1', agent: { runner: 'claude', reason: expect.stringContaining('automatic selection') } });
    expect(startRun).toHaveBeenCalledOnce();
    // The choice reaches the run's timeline through the real route.
    expect(startRun.mock.calls[0]?.[1]).toMatchObject({ task: 'Fix the login', managerAgent: { note: expect.stringContaining('Agent chosen by manager') } });
  });

  it('POST /runs refuses a manager fallback policy from anyone but the manager engine', async () => {
    const { id } = await createManager();
    const body = {
      workflow: 'quick-task', task: 'Sneak a fallback', runner: 'claude',
      startedByManager: { id, name: 'Manager' },
      managerAgent: { note: 'forged', fallback: [{ provider: 'claude', profileId: 'other' }] },
    };
    const forged = await request('/api/v1/runs', { method: 'POST', body });
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: 'managerAgent is set only by a cezar manager' });
    // A guessed token is no better.
    const guessed = await app.request('/api/v1/runs', {
      method: 'POST', headers: { ...JSON_HEADERS, 'x-cezar-manager-agent': '00000000-0000-4000-8000-000000000000' }, body: JSON.stringify(body),
    });
    expect(guessed.status).toBe(403);
    expect(await guessed.json()).toEqual({ error: 'managerAgent is set only by a cezar manager' });
    expect(startRun).not.toHaveBeenCalled();
    // Without managerAgent the same request starts a task as before.
    const { managerAgent: _managerAgent, ...plain } = body;
    expect((await request('/api/v1/runs', { method: 'POST', body: plain })).status).toBe(201);
  });

  it('POST /runs answers a non-ASCII token of the right length with a 403, not a 500', async () => {
    const response = await app.request('/api/v1/runs', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-cezar-manager-agent': `é${'a'.repeat(35)}` },
      body: JSON.stringify({ workflow: 'quick-task', task: 'x', startedByManager: { id: 'm', name: 'M' }, managerAgent: { note: 'n', fallback: [] } }),
    });
    expect(await response.clone().text()).toContain('managerAgent is set only by a cezar manager');
    expect(response.status).toBe(403);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('the server’s manager task-accounts lookup reads the manager’s current list by id', async () => {
    const created = await createManager({
      instructions: 'Watch', projects: 'all',
      taskAgents: [{ runner: 'claude', agentProfile: 'default' }, { runner: 'codex', agentProfile: 'default' }],
    });
    const policy = managerFallbackPolicy([{ provider: 'claude', profileId: 'default' }, { provider: 'codex', profileId: 'default' }], created.id);
    const live = { enabled: false, candidates: [], revision: 0, incarnation: null, revocation: null };
    const eligible = () => eligibleFallbackCandidates(policy, new Set(), new Set(), null).eligible.map((c) => c.provider);
    expect(fallbackConsentCurrent(policy, live)).toBe(true);
    expect(eligible()).toEqual(['claude', 'codex']);
    // An edit is read at fallback time, not snapshotted.
    expect((await request(`${BASE}/${created.id}`, { method: 'PATCH', body: { taskAgents: [{ runner: 'codex', agentProfile: 'default' }] } })).status).toBe(200);
    expect(eligible()).toEqual(['codex']);
    // Back to Automatic: no list to fall back within.
    expect((await request(`${BASE}/${created.id}`, { method: 'PATCH', body: { taskAgents: null } })).status).toBe(200);
    expect(fallbackConsentCurrent(policy, live)).toBe(false);
    // Each policy reads its own manager's list by id: the other manager lists only Claude, so its
    // policy drops Codex while this one's (re-listed with Codex) keeps it. A deleted manager withdraws its policy.
    expect((await request(`${BASE}/${created.id}`, { method: 'PATCH', body: { taskAgents: [{ runner: 'claude', agentProfile: 'default' }, { runner: 'codex', agentProfile: 'default' }] } })).status).toBe(200);
    const other = await createManager({ instructions: 'Other', projects: 'all', taskAgents: [{ runner: 'claude', agentProfile: 'default' }] });
    const otherPolicy = managerFallbackPolicy([{ provider: 'claude', profileId: 'default' }, { provider: 'codex', profileId: 'default' }], other.id);
    expect(fallbackConsentCurrent(otherPolicy, live)).toBe(true);
    expect(eligibleFallbackCandidates(otherPolicy, new Set(), new Set(), null).eligible.map((c) => c.provider)).toEqual(['claude']);
    expect(eligible()).toEqual(['claude', 'codex']);
    expect((await request(`${BASE}/${other.id}`, { method: 'DELETE' })).status).toBeLessThan(300);
    expect(fallbackConsentCurrent(otherPolicy, live)).toBe(false);
  });

  it('rejects direct switches without the in-process manager token', async () => {
    const record = store.createRun({ title: 'Review', workflow: 'quick-task', task: 'Review it', runner: 'claude', steps: [] });
    for (const headers of [JSON_HEADERS, { ...JSON_HEADERS, 'x-cezar-manager-agent': '00000000-0000-4000-8000-000000000000' }]) {
      const response = await app.request(`/api/v1/runs/${record.id}/switch-agent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runner: 'codex', agentProfile: 'default', changedBy: 'Release Manager' }),
      });
      expect(response.status).toBe(403);
    }
    expect(switchAgent).not.toHaveBeenCalled();
  });

  it('validates switches and forwards the resolved account and manager identity to the run engine', async () => {
    const { id, connectedProjectIds: [projectId] } = await createManager({
      name: 'Release Manager', instructions: '', projects: 'all', cronMinutes: 0,
      taskAgents: [{ runner: 'codex', agentProfile: 'default' }],
    });
    const run = store.createRun({ title: 'Review', workflow: 'quick-task', task: 'Review it', runner: 'claude', steps: [] });
    store.updateRun(run.id, { startedByManager: { id, name: 'Release Manager' } });
    const path = `${BASE}/${id}/task-switch`;
    const body = { projectId, runId: run.id };
    expect((await request(path, { method: 'POST', body })).status).toBe(400);
    expect((await request(path, { method: 'POST', body: { ...body, runner: 'codex', agentProfile: 'personal' } })).status).toBe(403);
    expect(switchAgent).not.toHaveBeenCalled();
    const response = await request(path, { method: 'POST', body: { ...body, runner: 'codex' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...body, notice: 'Switched task agent' });
    expect(switchAgent).toHaveBeenCalledWith(run.id, { runner: 'codex', agentProfile: 'default', changedBy: 'Release Manager' }, 'claude');
  });

  it('a fallback entry’s model crosses POST /runs, with the manager token, into the run’s input', async () => {
    // No live model discovery in a unit test: an unanswered catalog falls back to the static model check.
    await engine.shutdown();
    app = createApp({
      repoRoot: root, version: 'test', store,
      manager: { startRun, switchAgent, isActive: () => false } as unknown as RunManager,
      workspaceEvents: bus,
      modelCatalog: { get: async () => { throw new Error('offline'); } } as unknown as RunnerModelCatalog,
      onManagerEngine: (built) => { engine = built; },
    });
    const { id } = await createManager({ instructions: 'Watch', projects: 'all', runner: 'claude', taskAgents: [{ runner: 'claude', agentProfile: 'default' }] });
    const [projectId] = ((await (await request(`${BASE}/${id}`)).json()) as { connectedProjectIds: string[] }).connectedProjectIds;
    const response = await request(`${BASE}/${id}/tasks`, { method: 'POST', body: { projectId, task: 'Fix it', model: 'opus' } });
    expect(response.status).toBe(201);
    // Through the real route and its zod contract: a schema without `fallback[].model` strips it here.
    expect(startRun.mock.calls[0]?.[1]).toMatchObject({
      model: 'opus',
      managerAgent: { fallback: [{ provider: 'claude', profileId: 'default', model: 'opus' }] },
    });
  });

  it('refuses a project out of scope, through the route', async () => {
    const { id } = await createManager();
    const response = await request(`${BASE}/${id}/tasks`, { method: 'POST', body: { projectId: 'elsewhere', task: 'x' } });
    expect(response.status).toBe(403);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('persists the task agent and enforces it through the real run route, then clears to Automatic', async () => {
    const { id, connectedProjectIds } = await createManager({ instructions: '', projects: 'all', runner: 'claude', taskRunner: 'codex', cronMinutes: 0 });
    const [projectId] = connectedProjectIds;
    expect(await (await request(`${BASE}/${id}`)).json()).toMatchObject({ taskRunner: 'codex' });
    const path = `${BASE}/${id}/tasks`;
    expect((await request(path, { method: 'POST', body: { projectId, task: 'Use my selection', runner: 'claude' } })).status).toBe(201);
    expect(startRun.mock.calls.at(-1)?.[1]).toMatchObject({ runner: 'codex' });
    const automatic = await request(`${BASE}/${id}`, { method: 'PATCH', body: { taskRunner: null, runner: 'codex' } });
    expect(automatic.status).toBe(200);
    expect(await automatic.json()).not.toHaveProperty('taskRunner');
    expect((await request(path, { method: 'POST', body: { projectId, task: 'Use the manager backend' } })).status).toBe(201);
    expect(startRun.mock.calls.at(-1)?.[1]).toMatchObject({ runner: 'codex' });
    expect((await request(path, { method: 'POST', body: { projectId, task: 'Choose another agent', runner: 'claude' } })).status).toBe(201);
    expect(startRun.mock.calls.at(-1)?.[1]).toMatchObject({ runner: 'claude' });
  });

  it('rejects an unknown task agent on create and update', async () => {
    expect((await request(BASE, { method: 'POST', body: { instructions: '', projects: 'all', taskRunner: 'imaginary' } })).status).toBe(400);
    const { id } = await createManager();
    expect((await request(`${BASE}/${id}`, { method: 'PATCH', body: { taskRunner: 'imaginary' } })).status).toBe(400);
    expect(startRun).not.toHaveBeenCalled();
  });

  it.each(runnerSchema.options)('persists %s for newly spawned tasks independently of the manager agent and account', async (runner) => {
    const { id, connectedProjectIds: [projectId] } = await createManager({
      instructions: '', projects: 'all', runner: 'codex', agentProfile: 'default', taskRunner: runner, cronMinutes: 0,
    });
    const managerPath = `${BASE}/${id}`;
    expect(new ManagerStore().get(id)).toMatchObject({ runner: 'codex', agentProfile: 'default', taskRunner: runner });
    const spawn = async (requested?: string) => {
      const response = await request(`${managerPath}/tasks`, {
        method: 'POST', body: { projectId, task: 'Spawn with the selected agent', ...(requested ? { runner: requested } : {}) },
      });
      expect(response.status).toBe(201);
      return startRun.mock.calls.at(-1)?.[1];
    };
    // The real manager-task route forwards its resolved runner into the real POST /runs.
    expect(await spawn(runner === 'claude' ? 'codex' : 'claude')).toMatchObject({ runner });
    const automatic = await request(managerPath, { method: 'PATCH', body: { taskRunner: null } });
    expect(await automatic.json()).not.toHaveProperty('taskRunner');
    expect(new ManagerStore().get(id)).not.toHaveProperty('taskRunner');
    expect(await spawn()).toMatchObject({ runner: 'codex' });
    expect(await spawn(runner)).toMatchObject({ runner });
    const pinned = await request(managerPath, { method: 'PATCH', body: { taskRunner: runner } });
    expect(await pinned.json()).toMatchObject({ runner: 'codex', agentProfile: 'default', taskRunner: runner });
    expect(new ManagerStore().get(id)?.taskRunner).toBe(runner);
    expect(await spawn()).toMatchObject({ runner });
  });

  it('persists two Claude accounts and one Codex account and forwards only selected pairs into POST /runs', async () => {
    const add = async (provider: 'claude' | 'codex', label: string) => {
      const configDir = join(home, label);
      mkdirSync(configDir);
      const response = await request('/api/v1/workspace/agent-profiles', { method: 'POST', body: { provider, label, configDir } });
      expect(response.status).toBe(201);
      return agentProfileResponseSchema.parse(await response.json()).profile.id;
    };
    const first = await add('claude', 'First');
    const second = await add('claude', 'Second');
    const codex = await add('codex', 'Codex');
    const agents = [{ runner: 'claude', agentProfile: first }, { runner: 'claude', agentProfile: second }, { runner: 'codex', agentProfile: codex }];
    const { id, connectedProjectIds: [projectId] } = await createManager({ instructions: '', projects: 'all', runner: 'codex', agentProfile: 'default', taskAgents: agents, cronMinutes: 0 });
    expect(new ManagerStore().get(id)).toMatchObject({ runner: 'codex', agentProfile: 'default', taskAgents: agents });
    for (const agent of agents) {
      expect((await request(`${BASE}/${id}/tasks`, { method: 'POST', body: { projectId, task: 'Use this exact account', ...agent } })).status).toBe(201);
      expect(startRun.mock.calls.at(-1)?.[1]).toMatchObject(agent);
    }
    expect((await request(`${BASE}/${id}`, { method: 'PATCH', body: { taskAgents: [{ runner: 'codex', agentProfile: first }] } })).status).toBe(400);
    const before = startRun.mock.calls.length;
    for (const agent of [{ runner: 'opencode' }, { runner: 'claude', agentProfile: 'default' }, { runner: 'codex', agentProfile: first }]) {
      expect((await request(`${BASE}/${id}/tasks`, { method: 'POST', body: { projectId, task: 'Outside the allowed set', ...agent } })).status).toBe(403);
    }
    expect(startRun).toHaveBeenCalledTimes(before);
    await request(`${BASE}/${id}`, { method: 'PATCH', body: { name: 'Renamed' } });
    expect(new ManagerStore().get(id)?.taskAgents).toEqual(agents);
    const clear = await request(`${BASE}/${id}`, { method: 'PATCH', body: { taskAgents: null, taskRunner: null } });
    expect(await clear.json()).not.toHaveProperty('taskAgents');
    expect(new ManagerStore().get(id)).not.toHaveProperty('taskAgents');
    expect((await request(`${BASE}/${id}/tasks`, { method: 'POST', body: { projectId, task: 'Automatic account choice', runner: 'claude', agentProfile: 'default' } })).status).toBe(201);
    expect(startRun.mock.calls.at(-1)?.[1]).toMatchObject({ runner: 'claude', agentProfile: 'default' });
  });

  it('rejects empty, repeated, unknown and cross-provider task account choices before saving', async () => {
    const { id } = await createManager({ instructions: '', projects: 'all', cronMinutes: 0 });
    for (const taskAgents of [[], [{ runner: 'claude', agentProfile: 'missing' }], [{ runner: 'imaginary', agentProfile: 'default' }], [{ runner: 'claude' }, { runner: 'claude' }]]) {
      expect((await request(`${BASE}/${id}`, { method: 'PATCH', body: { taskAgents } })).status).toBe(400);
      expect(new ManagerStore().get(id)).not.toHaveProperty('taskAgents');
    }
    expect(startRun).not.toHaveBeenCalled();
  });

  it('merges only through the decision route, on the same code the GitHub tab uses', async () => {
    const { id, connectedProjectIds } = await createManager();
    const [projectId] = connectedProjectIds;
    const proposed = await request(`${BASE}/${id}/actions`, { method: 'POST', body: { action: { type: 'merge-pr', projectId, number: 128 }, reason: 'green' } });
    expect(proposed.status).toBe(201);
    const { actionId } = (await proposed.json()) as { actionId: string };

    const decided = await request(`${BASE}/${id}/actions/${actionId}/decision`, { method: 'POST', body: { decision: 'approve' } });
    expect(await decided.json()).toEqual({ ok: true });
    const { messages } = (await (await request(`${BASE}/${id}/messages`)).json()) as { messages: Array<{ id: string; status?: string; result?: string }> };
    expect(messages.find((message) => message.id === actionId)).toMatchObject({ status: 'done', result: 'Merged #128' });

    const again = await request(`${BASE}/${id}/actions/${actionId}/decision`, { method: 'POST', body: { decision: 'approve' } });
    expect(again.status).toBe(409);
  });

  it('a forged decision from another origin never reaches the engine', async () => {
    const { id } = await createManager();
    const response = await app.request(`${BASE}/${id}/actions/a/decision`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a second answer to a card that is already closed (Questions inbox)', async () => {
    const { id } = await createManager();
    const log = await import('../managers/store.ts').then(({ ManagerStore }) => new ManagerStore(() => undefined));
    const ask = { questions: [{ header: 'Base', question: 'Which base?', options: [{ label: 'main' }, { label: 'next' }] }] };
    log.persistMessage(id, { id: 'closed', seq: 0, at: 't', kind: 'assistant', turn: 'chat', text: '', streaming: false, commands: [], ask, askClosed: { reason: 'dismissed', at: 't' } } as ManagerMessage);
    const send = (askId: string) => request(`${BASE}/${id}/messages`, { method: 'POST', body: { text: 'Base: main', askId } });
    const refused = await send('closed');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'question already closed' });
  });

  it('an inactive manager refuses chat, Check now and a connector probe until reactivated (spec 2026-11-19-manager-deactivate)', async () => {
    const { id } = await createManager({ instructions: 'Watch', projects: 'all', cronMinutes: 0 });
    const off = await request(`${BASE}/${id}`, { method: 'PATCH', body: { active: false } });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { inactive?: { since: string } }).inactive?.since).toBeDefined();
    for (const [path, body] of [[`${BASE}/${id}/messages`, { text: 'hi' }], [`${BASE}/${id}/check`, undefined], [`${BASE}/${id}/connectors/refresh`, undefined]] as const) {
      const refused = await request(path, { method: 'POST', ...(body ? { body } : {}) });
      expect(refused.status, path).toBe(409);
      expect(await refused.json()).toEqual({ error: 'manager inactive' });
    }
    expect(managerStore().messages(id).filter((message) => message.kind === 'user')).toEqual([]);
    const sent = await request(`${BASE}/${id}/messages`, { method: 'POST', body: { text: 'hi', reactivate: true } });
    expect(sent.status).toBe(200);
    expect(managerStore().get(id)?.inactive).toBeUndefined();
    await vi.waitFor(() => expect(engine.inFlight()).toBe(0), { timeout: 15_000 });
    expect(managerStore().messages(id).filter((message) => message.kind === 'user').map((message) => 'text' in message && message.text)).toEqual(['hi']);
  });

  it('deactivates and reactivates every manager at once, answering the ids that changed', async () => {
    const one = await createManager({ instructions: 'Watch', projects: 'all', cronMinutes: 0 });
    const two = await createManager({ instructions: 'Watch', projects: 'all', cronMinutes: 0 });
    await request(`${BASE}/${two.id}`, { method: 'PATCH', body: { active: false } });
    const off = await request(`${BASE}/activity`, { method: 'POST', body: { active: false } });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, changed: [one.id] });
    const on = await request(`${BASE}/activity`, { method: 'POST', body: { active: true } });
    expect(((await on.json()) as { changed: string[] }).changed.sort()).toEqual([one.id, two.id].sort());
    expect((await request(`${BASE}/activity`, { method: 'POST', body: { active: true, extra: 1 } })).status).toBe(400);
  });

  it('keeps an inactive manager\'s question listed but out of the count, and answers it only with reactivate', async () => {
    const { id } = await createManager({ instructions: 'Watch', projects: 'all', cronMinutes: 0 });
    const ask = { questions: [{ header: 'Base', question: 'Which base?', options: [{ label: 'main' }, { label: 'next' }] }] };
    managerStore().persistMessage(id, { id: 'card', seq: 0, at: new Date().toISOString(), kind: 'assistant', turn: 'chat', text: '', streaming: false, commands: [], ask } as ManagerMessage);
    await request(`${BASE}/${id}`, { method: 'PATCH', body: { active: false } });
    const listed = (await (await request('/api/v1/workspace/questions')).json()) as { open: Array<{ key: string }>; counts: { live: number; older: number } };
    expect(listed.open.map((item) => item.key)).toEqual([`m:${id}:card`]);
    expect(listed.counts).toEqual({ live: 0, older: 0 });
    const answer = (body: unknown) => request(`/api/v1/workspace/questions/${encodeURIComponent(`m:${id}:card`)}/answer`, { method: 'POST', body });
    const refused = await answer({ text: 'Base: main' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'manager inactive' });
    expect((await answer({ text: 'Base: main', reactivate: true })).status).toBe(200);
    expect(managerStore().get(id)?.inactive).toBeUndefined();
    await vi.waitFor(() => expect(engine.inFlight()).toBe(0), { timeout: 15_000 });
  });

  it('pages history oldest-first within the page, newest page by default', async () => {
    const { id } = await createManager();
    const log = await import('../managers/store.ts').then(({ ManagerStore }) => new ManagerStore(() => undefined));
    for (let seq = 0; seq < 5; seq += 1) log.persistMessage(id, { id: `m${seq}`, seq, at: 't', kind: 'notice', text: String(seq) });
    const latest = (await (await request(`${BASE}/${id}/messages?limit=2`)).json()) as { messages: Array<{ seq: number }>; hasMore: boolean };
    expect(latest.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(latest.hasMore).toBe(true);
    const older = (await (await request(`${BASE}/${id}/messages?before=3&limit=10`)).json()) as { messages: Array<{ seq: number }>; hasMore: boolean };
    expect(older.messages.map((message) => message.seq)).toEqual([0, 1, 2]);
    expect(older.hasMore).toBe(false);
  });

  describe('kind=user', () => {
    it('returns only the user\'s messages and keeps before/limit', async () => {
      const { id } = await createManager();
      const log = await import('../managers/store.ts').then(({ ManagerStore }) => new ManagerStore(() => undefined));
      const kinds = ['user', 'notice', 'user', 'notice', 'user'] as const;
      kinds.forEach((kind, seq) =>
        log.persistMessage(id, kind === 'user' ? { id: `m${seq}`, seq, at: 't', kind, text: 'q' } : { id: `m${seq}`, seq, at: 't', kind, text: 'x' }));
      const page = async (query: string) =>
        (await (await request(`${BASE}/${id}/messages?${query}`)).json()) as { messages: Array<{ seq: number }>; hasMore: boolean };
      expect((await page('kind=user&limit=2')).messages.map((m) => m.seq)).toEqual([2, 4]);
      const older = await page('kind=user&limit=2&before=4');
      expect(older.messages.map((m) => m.seq)).toEqual([0, 2]);
      expect(older.hasMore).toBe(false);
    });
  });

  describe('pending=1', () => {
    const page = async (query: string) =>
      (await (await request(`${query}`)).json()) as { messages: Array<{ id: string; seq: number }>; hasMore: boolean };
    const action = { type: 'add-job', name: 'Nightly', prompt: 'p', everyMinutes: 60 } as const;

    it('answers an empty page when nothing is waiting, with or without messages', async () => {
      const { id } = await createManager();
      expect(await page(`${BASE}/${id}/messages?pending=1`)).toEqual({ messages: [], hasMore: false });
      const log = await import('../managers/store.ts').then(({ ManagerStore }) => new ManagerStore(() => undefined));
      log.persistMessage(id, { id: 'n', seq: 0, at: 't', kind: 'notice', text: 'x' });
      log.persistMessage(id, { id: 'done', seq: 1, at: 't', kind: 'action', action, status: 'done' });
      expect(await page(`${BASE}/${id}/messages?pending=1`)).toEqual({ messages: [], hasMore: false });
    });

    it('returns only waiting actions, honours before and limit, and leaves the plain read alone', async () => {
      const { id } = await createManager();
      const log = await import('../managers/store.ts').then(({ ManagerStore }) => new ManagerStore(() => undefined));
      log.persistMessage(id, { id: 'a0', seq: 0, at: 't', kind: 'action', action, status: 'pending' });
      log.persistMessage(id, { id: 'n', seq: 1, at: 't', kind: 'notice', text: 'x' });
      log.persistMessage(id, { id: 'a2', seq: 2, at: 't', kind: 'action', action, status: 'rejected' });
      log.persistMessage(id, { id: 'a3', seq: 3, at: 't', kind: 'action', action, status: 'pending' });
      log.persistMessage(id, { id: 'a4', seq: 4, at: 't', kind: 'action', action, status: 'pending' });
      const newest = await page(`${BASE}/${id}/messages?pending=1&limit=2`);
      expect(newest.messages.map((message) => message.id)).toEqual(['a3', 'a4']);
      expect(newest.hasMore).toBe(true);
      const oldest = await page(`${BASE}/${id}/messages?pending=1&limit=2&before=3`);
      expect(oldest.messages.map((message) => message.id)).toEqual(['a0']);
      expect(oldest.hasMore).toBe(false);
      expect((await page(`${BASE}/${id}/messages`)).messages).toHaveLength(5);
    });

    it('refuses any other value', async () => {
      const { id } = await createManager();
      expect((await request(`${BASE}/${id}/messages?pending=0`)).status).toBe(400);
    });
  });

  it('keeps managerConfirm in the workspace ui-state and bounds what it accepts', async () => {
    const put = (managerConfirm: object) => request('/api/v1/workspace/ui-state', { method: 'PUT', body: { managerConfirm } });
    expect((await put({ 'merge-pr': false, 'enable-automation': true, 'add-job': true })).status).toBe(200);
    expect(await (await request('/api/v1/workspace/ui-state')).json()).toMatchObject({ managerConfirm: { 'merge-pr': false } });
    expect((await put({ 'merge-pr': 'no' })).status).toBe(400);
    expect((await put({ other: false })).status).toBe(400);
  });
});

describe('the dry-run manager turn', () => {
  let dir: string;
  const saved = { PATH: process.env.PATH, CEZ_MOCK_PACE: process.env.CEZ_MOCK_PACE };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-managers-mock-'));
    mkdirSync(join(dir, 'bin'));
    // Stands in for the shim: answers `status --json` and records every call.
    const shim = join(dir, 'bin', 'cez-manager');
    writeFileSync(shim, `#!/bin/sh
echo "$@" >> "${join(dir, 'calls')}"
case "$1" in
  status) echo '{"projects":[{"projectId":"p","tasks":[{"runId":"r1"}],"prs":[{"number":9,"draft":true},{"number":8}]}]}' ;;
  merge) echo proposed ;;
esac
`);
    chmodSync(shim, 0o755);
    process.env.PATH = `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
    process.env.CEZ_MOCK_PACE = '0';
  });

  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.CEZ_MOCK_PACE === undefined) delete process.env.CEZ_MOCK_PACE; else process.env.CEZ_MOCK_PACE = saved.CEZ_MOCK_PACE;
    rmSync(dir, { recursive: true, force: true });
  });

  const turn = async (userPrompt: string) => {
    const events: AgentEvent[] = [];
    const bin = join(import.meta.dirname, '..', '..', 'scripts', 'mock-claude.mjs');
    const session = new ClaudeCliRunner({ bin }).startSession({ userPrompt, cwd: dir }, (event) => events.push(event), { autoEndAfterFirstTurn: true });
    await session.result;
    return {
      text: events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('\n'),
      commands: events.flatMap((event) => (event.type === 'tool-call' ? [(event.input as { command: string }).command] : [])),
    };
  };

  it('is scripted: a command, a task card, no proposal unless asked', async () => {
    const { text, commands } = await turn('[cez-manager:chat]\nwhat is going on?');
    expect(commands).toEqual(['cez-manager status --json']);
    expect(text).toContain('[[task:p/r1]]');
  });

  it('proposes merging the first non-draft pull request when asked', async () => {
    const { text, commands } = await turn('[cez-manager:chat]\nplease merge what is ready');
    expect(commands[1]).toContain('cez-manager merge --project p 8');
    expect(text).toContain('[[pr:p/8]]');
  });

  it('does not read "merge" in anything before the user\'s own words', async () => {
    const { commands } = await turn('Since your last turn:\n- Merge of p#3: Merged #3\n\n[cez-manager:chat]\nhow are we?');
    expect(commands).toEqual(['cez-manager status --json']);
  });

  it('a watch with nothing new is quiet', async () => {
    expect((await turn('[cez-manager:watch]\nNew attention items: 0.')).text).toBe('MANAGER:QUIET');
  });
});

/**
 * The acceptance path for a long paste (2026-11-10, Notes Manager): a real cockpit socket, the
 * dry-run Claude, the real `cez-manager` shim and CLI. Nothing but a flag crosses the shell, and
 * the task's objective holds the user's text byte for byte.
 */
describe('filing a long paste, end to end', () => {
  const root = join(import.meta.dirname, '..', '..', '..', '..');
  const keys = ['CEZ_HOME', 'CEZ_DRY_RUN', 'CEZ_MANAGERS', 'CEZ_API_URL', 'CEZ_BIN', 'CEZ_MOCK_PACE'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let dir: string;
  let store: RunStore;
  let engine: ManagerEngine;
  let server: ReturnType<typeof serve>;
  let startRun: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cez-managers-paste-'));
    mkdirSync(join(dir, 'repo'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: join(dir, 'repo') });
    process.env.CEZ_HOME = join(dir, 'home');
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_PACE = '0';
    delete process.env.CEZ_MANAGERS;
    // The shim runs `node "$CEZ_BIN" manager …`: point it at the source CLI through tsx.
    const entry = join(dir, 'cez.mjs');
    writeFileSync(entry, `const { register } = await import(${JSON.stringify(join(root, 'node_modules', 'tsx', 'dist', 'esm', 'api', 'index.mjs'))});
register();
await import(${JSON.stringify(join(root, 'packages', 'cezar', 'src', 'index.ts'))});
`);
    process.env.CEZ_BIN = entry;
    store = RunStore.open(join(dir, 'repo', '.ai/cezar'));
    startRun = vi.fn(() => ({ id: 'filed-run' }));
    const app = createApp({
      repoRoot: join(dir, 'repo'),
      version: 'test',
      store,
      manager: { startRun, isActive: () => false } as unknown as RunManager,
      workspaceEvents: new WorkspaceEventBus(),
      onManagerEngine: (built) => { engine = built; },
    });
    server = await new Promise((resolve) => {
      const started = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(started));
    });
    process.env.CEZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await engine.shutdown();
    await new Promise((resolve) => server.close(resolve));
    store.flush();
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards a 20k+ multi-line Polish transcript with quotes, $ and backticks verbatim', async () => {
    const transcript = Array.from({ length: 240 }, (_, index) =>
      `[${String(index).padStart(3, '0')}] Łukasz: „Zażółć gęślą jaźń” — it's "ważne", budżet $${index}.50, odpal \`npm test\` albo $(whoami); 'koniec'`).join('\n');
    expect(transcript.length).toBeGreaterThan(20_000);
    const api = (path: string, body?: unknown) => fetch(`${process.env.CEZ_API_URL}/api/v1/workspace/managers${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const created = (await (await api('', { instructions: 'File notes', projects: 'all', cronMinutes: 0 })).json()) as { id: string };
    const text = `File this, please:\n\n${transcript}`;
    expect((await api(`/${created.id}/messages`, { text })).status).toBe(200);
    await vi.waitFor(async () => {
      const { messages } = (await (await api(`/${created.id}/messages`)).json()) as { messages: ManagerMessage[] };
      const reply = messages.find((message) => message.kind === 'assistant');
      expect(reply?.kind === 'assistant' && !reply.streaming).toBe(true);
    }, { timeout: 90_000, interval: 250 });

    const { messages } = (await (await api(`/${created.id}/messages`)).json()) as { messages: ManagerMessage[] };
    const reply = messages.find((message): message is Extract<ManagerMessage, { kind: 'assistant' }> => message.kind === 'assistant')!;
    expect(reply.error).toBeUndefined();
    expect(reply.commands.every((command) => !command.isError)).toBe(true);
    const filing = reply.commands.find((command) => command.summary.includes('task create'))!;
    expect(filing.summary).toContain('--attach-last-user-message');
    expect(filing.summary.length).toBeLessThan(200);
    expect(filing.output).toContain(`verbatim: ${text.length} characters`);
    expect(reply.text).toMatch(/\[\[task:[^\]]+\/filed-run\]\]/);
    expect(startRun).toHaveBeenCalledOnce();
    const objective = (startRun.mock.calls[0]?.[1] as { task: string }).task;
    expect(objective).toContain(`\n${text}\n`);
    expect(Buffer.from(objective).includes(Buffer.from(transcript))).toBe(true);
  }, 120_000);
});
