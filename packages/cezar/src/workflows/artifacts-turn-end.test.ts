import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactsDir, RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { ASSESS_IMPACT_WORKFLOW } from './templates.ts';
import type { WorkflowDef } from './types.ts';

// The watcher only adds speed (spec Q2); it is silenced here so each case proves the turn-end
// rescan on its own, the guarantee a filesystem without working `fs.watch` relies on.
vi.mock('../runs/artifacts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runs/artifacts.ts')>()),
  watchArtifacts: () => ({ close: () => undefined }),
}));

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Artifacts reach the SSE bus at turn end from BOTH handlers in `workflows/run.ts` (spec
 * 2026-10-22-html-artifacts-and-impact Q2): `runAgentStep` (the run's first session) and
 * `runContinuation` (every Continue). Each parks at `waiting` here, so no terminal rescan can
 * stand in for the turn-end one. The dry-run mock writes `demo.html` on its first turn.
 */
describe('artifacts rescan at turn end', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  let published: Array<{ runId: string; names: string[]; status: string | undefined }>;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-artifacts-turn-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
    published = [];
    store.on('artifacts', (payload: { runId: string; artifacts: Array<{ name: string }> }) => {
      published.push({
        runId: payload.runId,
        names: payload.artifacts.map((a) => a.name),
        status: store.getRun(payload.runId)?.status,
      });
    });
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const waitFor = async (pred: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const status = (id: string): RunRecord['status'] | undefined => store.getRun(id)?.status;

  it('runAgentStep: the first session publishes what its turn wrote, while parked', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'write a page', worktree: false });
    currentId = record.id;
    await waitFor(() => status(record.id) === 'waiting');
    expect(existsSync(artifactsDir(join(repoRoot, '.ai/cezar'), record.id))).toBe(true);
    await waitFor(() => published.some((p) => p.names.includes('demo.html')), 5_000);
    expect(published.find((p) => p.names.includes('demo.html'))).toMatchObject({ runId: record.id });
  }, 40_000);

  it('runContinuation: a Continue session publishes what its turn wrote, while parked', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done first pass', worktree: false });
    currentId = record.id;
    await waitFor(() => ['done', 'review'].includes(status(record.id) ?? ''));
    const demo = join(artifactsDir(join(repoRoot, '.ai/cezar'), record.id), 'demo.html');
    await waitFor(() => published.some((p) => p.names.includes('demo.html')), 5_000);
    rmSync(demo);
    published.length = 0;

    expect(manager.continueRun(record.id, { text: 'now write it again' })).toEqual({ ok: true });
    await waitFor(() => status(record.id) === 'waiting');
    await waitFor(() => published.some((p) => p.names.includes('demo.html')), 5_000);
    expect(existsSync(demo)).toBe(true);
  }, 40_000);

  it('stays silent when the listing did not change', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'write a page', worktree: false });
    currentId = record.id;
    await waitFor(() => published.some((p) => p.names.includes('demo.html')));
    const before = published.length;
    await manager.rescanArtifacts(record.id);
    expect(published.length).toBe(before);
  }, 40_000);

  it('forgets a run\'s listing signature once its owner is gone', async () => {
    const record = manager.startRun(SINGLE_STEP, { task: 'mock:done first pass', worktree: false });
    currentId = record.id;
    await waitFor(() => ['done', 'review'].includes(status(record.id) ?? ''));
    await waitFor(() => published.some((p) => p.names.includes('demo.html')), 5_000);
    const signatures = (manager as unknown as { artifactSignatures: Map<string, string> }).artifactSignatures;
    await waitFor(() => !signatures.has(record.id), 5_000);
  }, 40_000);

  // The backstop (spec 2026-10-22 § Impact renderer): the dry-run mock leaves only review.json;
  // the turn-end rescan validates and renders it, and the run's diff stays empty.
  it('renders a review.json the turn left behind into impact.html, version 1', async () => {
    const record = manager.startRun(ASSESS_IMPACT_WORKFLOW, { task: 'Assess the impact of the spec .ai/specs/x.md' });
    currentId = record.id;
    await waitFor(() => published.some((p) => p.names.includes('impact.html')), 30_000);
    const dir = artifactsDir(join(repoRoot, '.ai/cezar'), record.id);
    expect(existsSync(join(dir, 'review.json'))).toBe(true);
    expect(existsSync(join(dir, '.versions/1/impact.html'))).toBe(true);
    expect(existsSync(join(dir, 'impact.errors.txt'))).toBe(false);
  }, 40_000);
});
