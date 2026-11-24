import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, isIdleParked, reconcileLoadedRun, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * A rejected agent login parks the task instead of failing it, and a reconnect of that account
 * resumes it once (spec 2026-11-18-inline-account-reconnect). Driven by the bundled mock's
 * `mock:auth-error`, Claude Code's revoked-token envelope.
 */
describe('auth park and reconnect resume', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedCodexBin = process.env.CEZ_CODEX_BIN;

  const record = (id: string): RunRecord => store.getRun(id)!;
  async function until(check: () => boolean, timeout = 20_000): Promise<void> {
    await expect.poll(check, { timeout }).toBe(true);
  }
  async function parkedRun(task = 'mock:auth-error'): Promise<string> {
    const started = manager!.startRun(QUICK_TASK_WORKFLOW, { task, worktree: false });
    await until(() => record(started.id).parked !== undefined && !manager!.isActive(started.id));
    return started.id;
  }

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    // The account-switch case continues on Codex: pin its fixture app-server, like the other Codex tests.
    process.env.CEZ_CODEX_BIN = fileURLToPath(new URL('../core/__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-auth-park-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      await until(() => store.listRuns().every(({ id }) => !manager?.isActive(id)), 25_000);
      manager.dispose();
      manager = undefined;
    }
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedCodexBin === undefined) delete process.env.CEZ_CODEX_BIN;
    else process.env.CEZ_CODEX_BIN = savedCodexBin;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 40_000);

  it('a rejected login on a workflow step parks the run at waiting, keeping its session', async () => {
    const id = await parkedRun();
    const parked = record(id);
    expect(parked.status).toBe('waiting');
    expect(parked.parked).toMatchObject({ kind: 'auth', provider: 'claude', profileId: 'default' });
    expect(parked.parked?.stepId).toBe(parked.steps.find((step) => step.status === 'failed')?.id);
    // The idle-park rest state: no process, no slot, and Continue reopens it.
    expect(isIdleParked(parked)).toBe(true);
    expect(parked.finishedAt).toBeUndefined();
    expect(parked.steps.some((step) => step.sessionId)).toBe(true);
    const lines = store.readEvents(id).map((event) => String(event.message ?? ''));
    expect(lines).toContain('agent sign-in expired — the task resumes once the account is reconnected');
    expect(lines.some((line) => line.startsWith('run failed'))).toBe(false);
  }, 40_000);

  it('a headless `cezar run` fails on a rejected login: no reconnect can reach it', async () => {
    manager!.dispose();
    manager = new RunManager(store, repoRoot, { parkOnAuth: false });
    const started = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:auth-error', worktree: false });
    await until(() => record(started.id).status === 'failed' && !manager!.isActive(started.id));
    expect(record(started.id).parked).toBeUndefined();
  }, 40_000);

  it('a rejected login on a continuation parks the run too', async () => {
    const started = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:done first', worktree: false });
    await until(() => ['done', 'review'].includes(record(started.id).status) && !manager!.isActive(started.id));
    expect(manager!.continueRun(started.id, { text: 'mock:auth-error' })).toEqual({ ok: true });
    await until(() => record(started.id).parked !== undefined && !manager!.isActive(started.id));
    expect(record(started.id)).toMatchObject({ status: 'waiting', parked: { kind: 'auth', stepId: 'continue-1' } });
    const lines = store.readEvents(started.id).map((event) => String(event.message ?? ''));
    expect(lines.some((line) => line.startsWith('continue failed'))).toBe(false);
  }, 40_000);

  it('a reconnect of that account continues the parked run once, on the same session, through the queue', async () => {
    const id = await parkedRun();
    const session = [...record(id).steps].reverse().find((step) => step.sessionId)?.sessionId;
    const continued = vi.spyOn(manager!, 'continueRun');
    // The mock re-reads the task on resume; the login works again now.
    store.updateRun(id, { task: 'mock:done ship it' });

    expect(manager!.resumeAuthParked('codex', 'default')).toEqual([]);
    expect(manager!.resumeAuthParked('claude', 'work')).toEqual([]);
    expect(record(id).parked).toBeDefined();

    expect(manager!.resumeAuthParked('claude', 'default')).toEqual([{ runId: id, title: record(id).title }]);
    // A second emit of the same reconnect finds nothing left to resume.
    expect(manager!.resumeAuthParked('claude', 'default')).toEqual([]);
    expect(continued).toHaveBeenCalledTimes(1);
    // Deferred for capacity: it queues under maxParallel like a usage-limit resume.
    expect(continued.mock.calls[0]?.[2]).toBe(true);
    expect(record(id).parked).toBeUndefined();
    expect(store.readEvents(id).some((event) => event.type === 'account-reconnected' && event.provider === 'claude' && event.profileId === 'default')).toBe(true);

    await until(() => ['done', 'review'].includes(record(id).status) && !manager!.isActive(id));
    expect(record(id).idleClosedAt).toBeUndefined();
    expect(record(id).steps.find((step) => step.id === 'continue-1')?.sessionId).toBe(session);
  }, 40_000);

  it('an archived parked run is not resumed, and a cancel retires the park', async () => {
    const archived = await parkedRun();
    store.setArchived(archived, true);
    expect(manager!.resumeAuthParked('claude', 'default')).toEqual([]);
    expect(record(archived).status).toBe('waiting');

    expect(manager!.cancel(archived)).toBe(true);
    expect(record(archived).status).toBe('cancelled');
    expect(record(archived).parked).toBeUndefined();
  }, 40_000);

  it('a project opened after the reconnect resumes only what parked before it', async () => {
    const id = await parkedRun();
    const at = record(id).parked!.at;
    expect(manager!.resumeAuthParked('claude', 'default', at)).toEqual([]);
    expect(manager!.resumeAuthParked('claude', 'default', new Date(Date.parse(at) + 1).toISOString())).toHaveLength(1);
  }, 40_000);

  it('a parked run survives a restart as waiting, for the recovering manager and a cold reader alike', async () => {
    const id = await parkedRun();
    manager!.dispose();
    manager = undefined;
    store.flush();

    const cold = reconcileLoadedRun(structuredClone(record(id)));
    expect(cold).toMatchObject({ status: 'waiting', parked: { kind: 'auth' } });

    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
    await manager.recover();
    expect(record(id)).toMatchObject({ status: 'waiting', parked: { kind: 'auth', provider: 'claude' } });
    expect(manager.isActive(id)).toBe(false);
    // And a reconnect after the restart still resumes it.
    expect(manager.resumeAuthParked('claude', 'default')).toHaveLength(1);
  }, 40_000);

  it('switching account on Continue clears the park and opens a fresh session', async () => {
    const id = await parkedRun();
    const session = [...record(id).steps].reverse().find((step) => step.sessionId)?.sessionId;
    expect(manager!.continueRun(id, { text: 'carry on', agentProfile: 'default', runner: 'codex' })).toEqual({ ok: true });
    await until(() => store.readEvents(id).some((event) => event.stepId === 'continue-1' && event.type === 'turn-end'));
    expect(record(id).parked).toBeUndefined();
    expect(record(id).runner).toBe('codex');
    const continued = record(id).steps.find((step) => step.id === 'continue-1');
    expect(continued?.sessionId).toBe('th_mock_1');
    expect(continued?.sessionId).not.toBe(session);
  }, 40_000);

  it('a failure that is not an auth rejection still fails the run', async () => {
    const started = manager!.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:credit', worktree: false });
    await until(() => record(started.id).status === 'failed' && !manager!.isActive(started.id));
    expect(record(started.id).parked).toBeUndefined();
  }, 40_000);
});
