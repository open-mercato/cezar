import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Trunk-based projects (spec 2026-10-20-trunk-based-projects), driven dry through
 * `scripts/mock-claude.mjs`: the project's default workspace puts a task in the checkout, a
 * `CEZ:DONE` lands what it left, a failing required check goes back to the agent, and a
 * read-only task runs beside a write task that holds the working-tree lease.
 */
// Real runs: well under a second alone, past the 5 s default under the full parallel suite.
describe('trunk-based projects', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  const writeConfig = (config: Record<string, unknown>) => {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify(config));
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-kb-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'daily.md'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    for (const record of store.listRuns()) manager.cancel(record.id);
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status ${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const notes = (id: string): string[] => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((e) => e.type === 'note')
      .map((e) => e.message ?? '');
  };

  const head = async () => (await run('git', ['log', '-1', '--format=%H %s'], { cwd: repoRoot })).stdout.trim();

  const clean = async () =>
    (await run('git', ['status', '--porcelain', '--', '.', ':(exclude).ai/cezar'], { cwd: repoRoot })).stdout;

  it('parks an interactive task for review on CEZ:DONE and lands it on Finish', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto', requiredChecks: ['test -f person.md'] });
    writeFileSync(join(repoRoot, 'person.md'), 'Bjorn\n');
    const before = await head();
    const record = manager.startRun(SINGLE_STEP, { task: '1on1 with Bjorn mock:done' });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    const parked = store.getRun(record.id)!;
    expect(parked).toMatchObject({ worktree: false });
    expect(parked.worktreePath).toBeUndefined();
    expect(parked.landing).toBeUndefined();
    expect(notes(record.id).some((n) => n.startsWith('changes ready for review'))).toBe(true);
    // Nothing committed yet: the user reviews the working-tree changes first.
    expect(await head()).toBe(before);
    expect(await clean()).not.toBe('');

    expect(manager.finish(record.id)).toBe(true);
    await waitFor(record.id, (r) => r?.status === 'done');
    const done = store.getRun(record.id)!;
    expect(done.landing).toMatchObject({ status: 'landed', branch: 'main' });
    expect(done.landing?.files).toContain('person.md');
    expect(await head()).toContain(done.landing!.sha!);
    expect(await clean()).toBe('');
  });

  it('Commit lands from the review park, says nothing to commit after, and lands directly once the session is gone', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto' });
    writeFileSync(join(repoRoot, 'person.md'), 'Bjorn\n');
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done' });
    await waitFor(record.id, (r) => r?.status === 'waiting');

    expect(await manager.land(record.id)).toMatchObject({ outcome: 'landed' });
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(await manager.land(record.id)).toEqual({ outcome: 'nothing', message: 'nothing to commit' });

    // A later edit to the checkout: no session to land with, so the server lands it itself.
    writeFileSync(join(repoRoot, 'person.md'), 'Bjorn, updated\n');
    expect(await manager.land(record.id)).toMatchObject({ outcome: 'landed' });
    expect(await clean()).toBe('');
  }, 30_000);

  it('Commit with no session reopens the task when a required check fails', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto' });
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done' });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    await manager.land(record.id);
    await waitFor(record.id, (r) => r?.status === 'done');
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto', requiredChecks: ['exit 1'] });
    writeFileSync(join(repoRoot, 'person.md'), 'broken\n');
    const answer = await manager.land(record.id);
    expect(answer).toEqual({ outcome: 'failed', message: 'checks failed — sent back to the agent to fix' });
    // The agent took it back; the mock answers without CEZ:DONE and parks for the user.
    await waitFor(record.id, (r) => r?.status === 'waiting');
  }, 30_000);

  it('holds the working tree while a session-less Commit lands, so nothing else edits the checkout', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto' });
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done' });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    await manager.land(record.id);
    await waitFor(record.id, (r) => r?.status === 'done');
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto', requiredChecks: ['sleep 1'] });
    writeFileSync(join(repoRoot, 'person.md'), 'later\n');
    const landing = manager.land(record.id);
    await new Promise((r) => setTimeout(r, 300));
    // Mid-landing, the checkout is taken: another Commit — or a queued in-place task — waits.
    expect(await manager.land(record.id)).toMatchObject({ outcome: 'busy' });
    expect(await landing).toMatchObject({ outcome: 'landed' });
    expect(await manager.land(record.id)).toEqual({ outcome: 'nothing', message: 'nothing to commit' });
  }, 30_000);

  it('never lands mid-turn: Finish during a running turn closes first and lands after', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto' });
    const before = await head();
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:pause' });
    writeFileSync(join(repoRoot, 'person.md'), 'half-done\n');
    // Finish answers false until the session is open; the mock's turn then holds ~2 s.
    await waitFor(record.id, (r) => r?.status === 'running' && manager.finish(record.id), 1_500);
    await new Promise((r) => setTimeout(r, 300));
    expect(store.getRun(record.id)?.landing).toBeUndefined();
    expect(await head()).toBe(before);
    // Once the turn is over, settle lands what it left.
    await waitFor(record.id, (r) => r?.status === 'done', 25_000);
    expect(store.getRun(record.id)?.landing).toMatchObject({ status: 'landed' });
    expect(await clean()).toBe('');
  }, 30_000);

  it('lands an autonomous task on CEZ:DONE without stopping for review', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto' });
    writeFileSync(join(repoRoot, 'person.md'), 'Bjorn\n');
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done', autonomous: true });
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(store.getRun(record.id)?.landing).toMatchObject({ status: 'landed' });
    expect(await clean()).toBe('');
  });

  it('sends a failing required check on Finish back to the agent instead of landing', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto', requiredChecks: ['exit 1'] });
    writeFileSync(join(repoRoot, 'person.md'), 'broken\n');
    const record = manager.startRun(SINGLE_STEP, { task: 'file it mock:done' });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    manager.finish(record.id);
    await waitFor(record.id, (r) => r?.landing?.status === 'failed');
    // The mock answers the failure without CEZ:DONE, so the run parks for the user again.
    await waitFor(record.id, (r) => r?.status === 'waiting' && notes(record.id).some((n) => n.startsWith('auto-land failed at checks — sent back to the agent')));
    expect(store.getRun(record.id)?.landing).toMatchObject({ status: 'failed', stage: 'checks' });
  });

  it('keeps the branch-per-task default: no config, an isolated worktree, no landing', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done' });
    await waitFor(record.id, (r) => r?.status === 'done');
    const done = store.getRun(record.id)!;
    expect(done.worktree).toBeUndefined();
    expect(done.worktreePath).toBeTruthy();
    expect(done.landing).toBeUndefined();
  });

  it('runs a read-only task beside a write task that holds the working-tree lease', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto' });
    const writer = manager.startRun(SINGLE_STEP, { task: 'mock:ask' });
    await waitFor(writer.id, (r) => r?.status === 'waiting');
    const reader = manager.startRun(SINGLE_STEP, { task: 'what is open with Daniel? mock:done', readOnly: true });
    await waitFor(reader.id, (r) => r?.status === 'done');
    const answered = store.getRun(reader.id)!;
    expect(answered).toMatchObject({ worktree: false, readOnly: true });
    expect(answered.landing).toBeUndefined();
    expect(answered.systemPrompt).toContain('READ-ONLY');
    expect(notes(reader.id)).toContain('read-only — answering from the repo working tree, alongside any running task');
    expect(store.getRun(writer.id)?.status).toBe('waiting');
  });

  it('does not let a git-tracked config grant auto-land', async () => {
    writeConfig({ taskWorkspace: 'in-place', landing: 'auto' });
    await run('git', ['add', '-f', '.ai/cezar/config.json'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'track config'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'person.md'), 'x\n');
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done' });
    await waitFor(record.id, (r) => r?.status === 'done');
    expect(store.getRun(record.id)?.landing).toBeUndefined();
    expect(notes(record.id).some((n) => n.startsWith('auto-land is off'))).toBe(true);
  });
});
