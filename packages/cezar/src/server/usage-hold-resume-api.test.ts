import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from '../workflows/run.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Resume now" for one agent account (spec 2026-08-03-auto-resume-after-usage-limit, 2026-11-23
 * addendum): `POST /api/v1/workspace/usage-holds/resume`. Workspace-level because a limit closes
 * an account in every project at once, so lifting it has to as well. Real managers on one shared
 * semaphore, through the bundled mock: what is proven is that queued work starts everywhere.
 */
describe('POST /api/v1/workspace/usage-holds/resume', () => {
  const saved: Record<string, string | undefined> = {};
  const temp: string[] = [];
  const workflow = QUICK_TASK_WORKFLOW;
  let roots: [string, string];
  let stores: [RunStore, RunStore];
  let managers: [RunManager, RunManager];
  let app: Hono;

  async function repo(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'cez-hold-resume-'));
    temp.push(root);
    await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: root });
    return root;
  }
  const post = (body: unknown) => apiRequest(app, '/api/v1/workspace/usage-holds/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeEach(async () => {
    for (const key of ['CEZ_DRY_RUN', 'CEZ_MOCK_LIMIT_RESET_SECONDS', 'CEZ_HOME', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    process.env.CEZ_HOME = mkdtempSync(join(tmpdir(), 'cez-hold-resume-home-'));
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cez-hold-resume-claude-'));
    temp.push(process.env.CEZ_HOME, process.env.CLAUDE_CONFIG_DIR);
    roots = [await repo(), await repo()];
    stores = [RunStore.open(join(roots[0], '.ai/cezar')), RunStore.open(join(roots[1], '.ai/cezar'))];
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 3 } });
    managers = [new RunManager(stores[0], roots[0], { semaphore }), new RunManager(stores[1], roots[1], { semaphore })];
    app = createApp({ repoRoot: roots[0], store: stores[0], manager: managers[0], semaphore, version: '0.0.0-test' }) as unknown as Hono;
  });

  afterEach(async () => {
    managers.forEach((manager, index) => { for (const { id } of stores[index]!.listRuns()) manager.cancel(id); });
    await sleep(300);
    for (const manager of managers) manager.dispose();
    for (const store of stores) store.flush();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('lifts the account in every project: queued work starts and the parked task resumes', async () => {
    const limited = managers[0].startRun(workflow, { task: 'mock:limit first' });
    await expect.poll(() => stores[0].getRun(limited.id)?.autoResumeAt, { timeout: 20_000 }).toBeDefined();
    stores[0].updateRun(limited.id, { task: 'mock:done resumed' });
    const here = managers[0].startRun(workflow, { task: 'mock:done queued here' });
    const there = managers[1].startRun(workflow, { task: 'mock:done queued in the other project' });
    await sleep(750);
    expect([stores[0].getRun(here.id)?.status, stores[1].getRun(there.id)?.status]).toEqual(['queued', 'queued']);
    // The queue says which account to lift — what the cockpit's button sends.
    await expect.poll(() => stores[1].getRun(there.id)?.queueWaitReason, { timeout: 5_000 }).toMatchObject({ kind: 'usage-reset', account: 'claude:default' });

    const res = await post({ account: 'claude:default' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: 'claude:default' });

    await expect.poll(() => stores[0].getRun(here.id)?.startedAt, { timeout: 15_000 }).toBeDefined();
    await expect.poll(() => stores[1].getRun(there.id)?.startedAt, { timeout: 15_000 }).toBeDefined();
    // …and the parked task resumes now rather than at the old deadline.
    const resumed = () => stores[0].readEvents(limited.id).some((event) => String(event.message ?? '').includes('resuming automatically (1/'));
    await expect.poll(resumed, { timeout: 15_000 }).toBe(true);
  }, 60_000);

  it('a resume still testing its window counts as having seen it: work queued behind it starts', async () => {
    const limited = managers[0].startRun(workflow, { task: 'mock:limit first' });
    await expect.poll(() => stores[0].getRun(limited.id)?.autoResumeAt, { timeout: 20_000 }).toBeDefined();
    // A resume whose session reports no window (a long turn): it holds the account in flight.
    stores[0].updateRun(limited.id, { task: 'mock:slow resumed', autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    (managers[0] as unknown as { fireAutoResume(id: string): void }).fireAutoResume(limited.id);
    await expect.poll(() => stores[0].getRun(limited.id)?.status, { timeout: 15_000 }).toBe('running');
    const there = managers[1].startRun(workflow, { task: 'mock:done queued in the other project' });
    await sleep(750);
    expect(stores[1].getRun(there.id)?.queueWaitReason).toEqual({ kind: 'account-resume' });

    const res = await post({ account: 'claude:default' });
    expect(await res.json()).toEqual({ account: 'claude:default', released: 1 });
    await expect.poll(() => stores[1].getRun(there.id)?.startedAt, { timeout: 8_000 }).toBeDefined();
    expect(stores[0].getRun(limited.id)).toMatchObject({ status: 'running', autoResumeWindowOpen: true });
  }, 60_000);

  it('404s an account cezar does not know, 400s one that is not an account at all', async () => {
    expect((await post({ account: 'claude:no-such-login' })).status).toBe(404);
    expect((await post({ account: 'nonsense:default' })).status).toBe(404);
    expect((await post({ account: 'claude' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('is workspace-level only — never mounted under a project scope', async () => {
    const res = await apiRequest(app, '/api/v1/p/default/workspace/usage-holds/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'claude:default' }),
    });
    expect(res.status).toBe(404);
  });
});
