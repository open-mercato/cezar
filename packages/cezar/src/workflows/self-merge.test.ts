import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);

/**
 * Self-merge through the engine (`config.selfMerge`, agents-master I050 "Closer 2"): a run that
 * ends on `CEZ:DONE` lands in `main`, loses its worktree and is archived; a refusal parks it at
 * `review` with the reason and leaves `main` alone. Driven dry through `scripts/mock-claude.mjs`,
 * whose `mock:write` leaves a file the finalize autosave commits onto the task branch.
 */
describe('RunManager self-merge', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  const git = async (...args: string[]) => (await run('git', args, { cwd: repoRoot })).stdout.trim();
  const writeConfig = (value: unknown) => {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify(value));
  };

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-selfmerge-run-'));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'test');
    await git('config', 'user.email', 'test@local');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status ${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const lifecycle = (id: string): string[] => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((e) => e.type === 'lifecycle')
      .map((e) => String(e.message));
  };

  const finished = (r: RunRecord | undefined) => r?.status === 'done' || r?.status === 'review' || r?.status === 'failed';

  it('merges a CEZ:DONE run into main, records the sha, removes the worktree and archives the run', async () => {
    writeConfig({ selfMerge: true });
    const before = await git('rev-parse', 'main');
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:write mock:done make the change' });
    await waitFor(record.id, (r) => r?.archived === true);
    const settled = store.getRun(record.id) as RunRecord;
    expect(settled.status).toBe('done');
    expect(settled.worktreePath).toBeUndefined();
    const head = await git('rev-parse', 'main');
    expect(head).not.toBe(before);
    expect(await git('rev-parse', 'main^1')).toBe(before);
    expect(existsSync(join(repoRoot, 'mock-write.txt'))).toBe(true);
    expect(lifecycle(record.id)).toContainEqual(`merged ${settled.branch} into main as ${head} — not pushed (no remote)`);
    expect(existsSync(join(repoRoot, '.ai/cezar/worktrees', record.id))).toBe(false);
    // The merged branch is deleted with its worktree.
    await expect(git('rev-parse', '--verify', '--quiet', `refs/heads/${settled.branch}`)).rejects.toThrow();
  });

  it('does nothing new with selfMerge off (the default): done, not archived, main untouched', async () => {
    const before = await git('rev-parse', 'main');
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:write mock:done make the change' });
    await waitFor(record.id, finished);
    const settled = store.getRun(record.id) as RunRecord;
    expect(settled.status).toBe('done');
    expect(settled.archived).toBe(false);
    expect(settled.worktreePath).toBeDefined();
    expect(await git('rev-parse', 'main')).toBe(before);
  });

  it('parks at review with the reason and leaves main untouched when the main checkout is dirty', async () => {
    writeConfig({ selfMerge: true });
    writeFileSync(join(repoRoot, 'a.txt'), 'dirty\n');
    const before = await git('rev-parse', 'main');
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:write mock:done make the change' });
    await waitFor(record.id, finished);
    const settled = store.getRun(record.id) as RunRecord;
    expect(settled.status).toBe('review');
    expect(settled.archived).toBe(false);
    expect(settled.worktreePath && existsSync(settled.worktreePath)).toBe(true);
    expect(lifecycle(record.id)).toContainEqual(
      'self-merge stopped — the main checkout has uncommitted changes to tracked files; "main" is untouched',
    );
    expect(await git('rev-parse', 'main')).toBe(before);
  });

  it('parks at review when the configured check fails, with the merge aborted', async () => {
    writeConfig({ selfMerge: true, checkCommand: 'exit 1' });
    const before = await git('rev-parse', 'main');
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:write mock:done make the change' });
    await waitFor(record.id, finished);
    expect(store.getRun(record.id)?.status).toBe('review');
    expect(lifecycle(record.id).some((m) => m.startsWith('self-merge stopped — the check `exit 1` failed'))).toBe(true);
    expect(await git('rev-parse', 'main')).toBe(before);
    expect(existsSync(join(repoRoot, 'mock-write.txt'))).toBe(false);
  });

  /** A settlement without `CEZ:DONE` (Finish, a restart) and a dispatch child never self-merge. */
  async function committedRun(extra: Partial<RunRecord> = {}): Promise<RunRecord> {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch, ...extra });
    writeFileSync(join(wt.path, 'b.txt'), 'two\n');
    await run('git', ['add', '-A'], { cwd: wt.path });
    await run('git', ['commit', '-q', '-m', 'work'], { cwd: wt.path });
    return store.getRun(record.id) as RunRecord;
  }
  const settle = (id: string, state?: object) =>
    (manager as unknown as { settleSuccess(id: string, state?: object): Promise<void> }).settleSuccess(id, state);
  const doneState = () => ({ goalAchieved: true, autosaveExcludedPaths: new Map() });

  it('does not merge a run settled without CEZ:DONE', async () => {
    writeConfig({ selfMerge: true });
    const before = await git('rev-parse', 'main');
    const record = await committedRun();
    await settle(record.id, { autosaveExcludedPaths: new Map() });
    expect(store.getRun(record.id)?.status).toBe('done');
    expect(store.getRun(record.id)?.archived).toBe(false);
    expect(await git('rev-parse', 'main')).toBe(before);
  });

  it('does not merge a dispatch child into the base (it lands in its parent)', async () => {
    writeConfig({ selfMerge: true });
    const before = await git('rev-parse', 'main');
    const record = await committedRun({
      dispatch: { rootRunId: 'root', parentRunId: 'root', kind: 'implement' } as RunRecord['dispatch'],
    });
    await settle(record.id, doneState());
    expect(store.getRun(record.id)?.archived).toBe(false);
    expect(await git('rev-parse', 'main')).toBe(before);
  });

  it('merges through settleSuccess on CEZ:DONE with the configured base branch', async () => {
    writeConfig({ selfMerge: true, baseBranch: 'main' });
    const record = await committedRun();
    await settle(record.id, doneState());
    expect(store.getRun(record.id)).toMatchObject({ status: 'done', archived: true });
    expect(existsSync(join(repoRoot, 'b.txt'))).toBe(true);
  });
});
