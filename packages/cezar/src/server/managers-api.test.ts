import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import type { AgentEvent } from '../core/agent-runner.ts';
import type { ManagerEngine } from '../managers/engine.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, WorkspaceEventBus } from './server.ts';

const JSON_HEADERS = { 'content-type': 'application/json', host: '127.0.0.1' };
const BASE = '/api/v1/workspace/managers';

describe('the managers routes', () => {
  let root: string;
  let home: string;
  let store: RunStore;
  let engine: ManagerEngine;
  let startRun: ReturnType<typeof vi.fn>;
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
    bus = new WorkspaceEventBus();
    app = createApp({
      repoRoot: root,
      version: 'test',
      store,
      manager: { startRun, isActive: () => false } as unknown as RunManager,
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

  it('leaves every other route alone under CEZ_MANAGERS=0', async () => {
    process.env.CEZ_MANAGERS = '0';
    expect((await request('/api/v1/health')).status).toBe(200);
    expect((await request('/api/v1/runs')).status).toBe(200);
  });

  it('validates as middleware and 404s an unknown manager', async () => {
    expect((await request(BASE, { method: 'POST', body: { totalNonsense: 1 } })).status).toBe(400);
    expect((await request(`${BASE}/NOT VALID`)).status).toBe(400);
    expect((await request(BASE, { method: 'POST', body: { instructions: 'x', projects: 'all', model: 'm'.repeat(201) } })).status).toBe(400);
    expect((await request(`${BASE}/missing`)).status).toBe(404);
    expect((await request(`${BASE}/missing/messages`)).status).toBe(404);
    expect((await request(`${BASE}/missing/check`, { method: 'POST' })).status).toBe(404);
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
    expect(await response.json()).toEqual({ projectId, runId: 'run-1' });
    expect(startRun).toHaveBeenCalledOnce();
    expect(startRun.mock.calls[0]?.[1]).toMatchObject({ task: 'Fix the login' });
  });

  it('refuses a project out of scope, through the route', async () => {
    const { id } = await createManager();
    const response = await request(`${BASE}/${id}/tasks`, { method: 'POST', body: { projectId: 'elsewhere', task: 'x' } });
    expect(response.status).toBe(403);
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
