import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { RunStore } from '../runs/store.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { createApp } from '../server/server.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApiClient } from './api.ts';
import { buildMcpServer, startRunInputSchema } from './tools.ts';

/**
 * The tools against the REAL router (#1109): every route a tool names must exist under the spelling
 * it uses, and what `start_run`'s `inputSchema` accepts must be what `POST /runs` accepts. The
 * manager is a capturing stub — what is pinned is the HTTP boundary, not the engine.
 */
describe('cez mcp tools over the real /api/v1 router', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let app: Hono;
  let started: Array<{ workflow: string; input: Record<string, unknown> }>;
  let cancelled: string[];
  let engine: string[];
  let mcp: Client;
  const saved = { dryRun: process.env.CEZ_DRY_RUN, home: process.env.CEZ_HOME };

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mcp-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-mcp-repo-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    started = [];
    cancelled = [];
    engine = [];
    const manager = {
      isActive: () => false,
      sendMessage: (id: string, content: Array<{ type: string; text?: string }>) => {
        engine.push(`message ${id}: ${content.map((b) => b.text).join('')}`);
        if (store.getRun(id)?.status !== 'waiting') return false;
        store.updateRun(id, { status: 'running' });
        return true;
      },
      enqueueMessage: () => null,
      deferMessage: () => false,
      finish: (id: string) => {
        engine.push(`finish ${id}`);
        if (store.getRun(id)?.status !== 'review') return false;
        store.updateRun(id, { status: 'done' });
        return true;
      },
      continueRun: (id: string, opts: { text?: string }) => {
        engine.push(`continue ${id}: ${opts.text}`);
        store.updateRun(id, { status: 'running' });
        return { ok: true };
      },
      startRun: (workflow: { name: string }, input: { task: string } & Record<string, unknown>) => {
        started.push({ workflow: workflow.name, input });
        return store.createRun({ title: input.task, workflow: workflow.name, task: input.task, steps: [] });
      },
      cancel: (id: string) => {
        cancelled.push(id);
        return true;
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test' });
    const api = createApiClient({
      baseUrl: 'http://127.0.0.1:4321',
      fetch: (input, init) => apiRequest(app, input instanceof Request ? input.url : String(input), init),
    });
    const server = buildMcpServer({ cockpit: async () => ({ api, defaultProjectId: 'default' }), version: '0.0.0-test', pollIntervalMs: 10 });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    mcp = new Client({ name: 'test', version: '0.0.0' });
    await mcp.connect(clientSide);
  });

  afterEach(async () => {
    await mcp.close();
    store.flush();
    for (const dir of [repoRoot, home]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dryRun], ['CEZ_HOME', saved.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const call = (name: string, args: Record<string, unknown> = {}) => mcp.callTool({ name, arguments: args });
  const text = (result: { content?: unknown }) => (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');

  it('start_run → get_run_status → wait_for_runs → cancel_run against the routes', async () => {
    const body = { workflow: 'quick-task', task: 'Fix the bug', runner: 'claude', autonomous: true, worktree: false };
    expect(startRunInputSchema.safeParse(body).success).toBe(true);
    const created = await call('start_run', body);
    expect(created.isError, text(created)).toBeFalsy();
    const run = created.structuredContent as { id: string; status: string; workflow: string };
    expect(run.workflow).toBe('quick-task');
    expect(started).toEqual([
      { workflow: 'quick-task', input: expect.objectContaining({ task: 'Fix the bug', runner: 'claude', autonomous: true, worktree: false }) },
    ]);

    const status = await call('get_run_status', { runId: run.id });
    expect(status.structuredContent).toMatchObject({ id: run.id, status: run.status });

    store.updateRun(run.id, { status: 'review' });
    const waited = await call('wait_for_runs', { runIds: [run.id], timeoutSeconds: 5 });
    expect(waited.structuredContent).toMatchObject({ runs: [{ id: run.id, status: 'review' }], timedOut: false });

    const full = await call('get_run', { runId: run.id });
    expect(full.structuredContent).toMatchObject({ id: run.id, task: 'Fix the bug', status: 'review' });

    const cancel = await call('cancel_run', { runId: run.id });
    expect(cancel.structuredContent).toEqual({ cancelled: true });
    expect(cancelled).toEqual([run.id]);
  });

  it('an unknown workflow is the route\'s 404, as a tool error', async () => {
    const result = await call('start_run', { workflow: 'no-such-workflow', task: 'x' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('cezar refused: 404: unknown workflow: no-such-workflow');
    expect(started).toEqual([]);
  });

  it('an unknown run is a 404 from every run tool', async () => {
    const notFound = 'cezar refused: 404: not found — no project of this cockpit has a run nope — check the id (list_runs)';
    for (const name of ['get_run', 'get_run_status', 'list_run_events']) {
      const result = await call(name, { runId: 'nope' });
      expect(result.isError, name).toBe(true);
      // the real index does not list it either: no project has it
      expect(text(result), name).toBe(notFound);
    }
    // A write never guesses: it lists the projects (none in this unregistered temp repo's registry).
    for (const [name, args] of [
      ['cancel_run', {}],
      ['push_run_branch', {}],
      ['send_run_message', { text: 'hi' }],
      ['review_run', { decision: 'accept' }],
    ] as const) {
      const result = await call(name, { runId: 'nope', ...args });
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toMatch(new RegExp(`^${notFound.replace(/[()]/g, '\\$&')}; this cockpit serves \\d+ projects? \\(.*\\) — pass projectId to say which one holds it$`));
    }
    expect(engine).toEqual([]);
  });

  it('send_run_message at waiting → review_run send_back → review_run accept, through the routes', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'waiting' });
    const answered = await call('send_run_message', { runId: run.id, text: 'Use option B' });
    expect(answered.structuredContent).toEqual({ delivered: true, projectId: 'default', runId: run.id, status: 'waiting' });

    store.updateRun(run.id, { status: 'done' });
    const late = await call('send_run_message', { runId: run.id, text: 'too late' });
    expect(text(late)).toMatch(/^run .* is done: send_run_message reaches only a waiting, running or queued run/);

    store.updateRun(run.id, { status: 'review' });
    const sentBack = await call('review_run', { runId: run.id, decision: 'send_back', notes: 'Rename it' });
    expect(sentBack.structuredContent).toEqual({ continued: true, projectId: 'default', runId: run.id, decision: 'send_back', status: 'running' });

    store.updateRun(run.id, { status: 'review' });
    const accepted = await call('review_run', { runId: run.id, decision: 'accept' });
    expect(accepted.structuredContent).toEqual({ finished: true, projectId: 'default', runId: run.id, decision: 'accept', status: 'done' });
    expect(engine).toEqual([`message ${run.id}: Use option B`, `continue ${run.id}: Review feedback:\nRename it`, `finish ${run.id}`]);
  });

  it('push_run_branch pushes the worktree branch to a local bare remote, and a non-fast-forward is refused', async () => {
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const bare = join(repoRoot, 'remote.git');
    const worktree = join(repoRoot, 'wt');
    g(repoRoot, 'init', '-q', '--bare', bare);
    g(repoRoot, 'init', '-q', '-b', 'main', worktree);
    for (const [k, v] of [['user.email', 't@cezar.local'], ['user.name', 't'], ['commit.gpgsign', 'false']]) g(worktree, 'config', k!, v!);
    g(worktree, 'remote', 'add', 'origin', bare);
    writeFileSync(join(worktree, 'a.txt'), 'a\n');
    g(worktree, 'add', '-A');
    g(worktree, 'commit', '-qm', 'base');
    g(worktree, 'checkout', '-qb', 'cez/task');
    writeFileSync(join(worktree, 'a.txt'), 'b\n');
    g(worktree, 'commit', '-qam', 'fix: the thing');
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status: 'review', worktreePath: worktree, baseBranch: 'main', branch: 'cez/task' });

    const pushed = await call('push_run_branch', { runId: run.id });
    expect(pushed.isError, text(pushed)).toBeFalsy();
    const head = g(worktree, 'rev-parse', 'HEAD');
    expect(pushed.structuredContent).toEqual({
      pushed: true, branch: 'cez/task', remote: 'origin', upstreamSet: true, projectId: 'default', runId: run.id,
      head: { sha: head, subject: 'fix: the thing' }, commits: 1,
    });
    expect(g(bare, 'rev-parse', 'refs/heads/cez/task')).toBe(head);

    // Someone else moves the remote branch; the run's rewritten history is refused, not forced.
    const other = join(repoRoot, 'other');
    g(repoRoot, 'clone', '-q', '-b', 'cez/task', bare, other);
    for (const [k, v] of [['user.email', 'o@cezar.local'], ['user.name', 'o'], ['commit.gpgsign', 'false']]) g(other, 'config', k!, v!);
    g(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
    g(other, 'push', '-q');
    g(worktree, 'commit', '-q', '--allow-empty', '-m', 'ours');
    const refused = await call('push_run_branch', { runId: run.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/^cezar refused: 409: push rejected: \[rejected\] .*\((fetch first|non-fast-forward)\) — .* cez mcp does not force-push/);
    expect(g(bare, 'log', '-1', '--format=%s', 'refs/heads/cez/task')).toBe('theirs');
  });

  it('the read tools reach their routes and answer in their output schema', async () => {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.appendEvent(run.id, { type: 'text', text: 'hello' });
    for (const [name, args] of [
      ['list_projects', {}],
      ['list_workflows', {}],
      ['list_runs', {}],
      ['list_run_events', { runId: run.id }],
      ['list_run_events', { runId: run.id, afterSeq: 0 }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
    }
    const workflows = (await call('list_workflows')).structuredContent as { workflows: Array<{ name: string }> };
    expect(workflows.workflows.map((w) => w.name)).toContain('quick-task');
    // The index reads the project REGISTRY, which this unregistered temp repo is not in.
    expect((await call('list_runs')).structuredContent).toMatchObject({ runs: [], total: 0 });
    const events = (await call('list_run_events', { runId: run.id })).structuredContent as { events: Array<{ type: string }> };
    expect(events.events.map((e) => e.type)).toContain('text');
  });
});
