import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHarnessDriver } from '../harness/driver.ts';
import { acquireIssueClaim } from '../harness/issue-claim.ts';
import { createLedger, loadLedger, saveLedger } from '../harness/ledger.ts';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE, HARNESS_TEXT_ONLY_ERROR } from '../harness/workflows.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

vi.mock('../harness/driver.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/driver.ts')>()),
  runHarnessDriver: vi.fn(async () => null),
}));

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const workflow = harnessWorkflowDefs().find((item) => item.name === HARNESS_FIX_ISSUE)!;

// an ending that never reaches the driver skipped its claim release, so a run
// recovered after a crash and cancelled from the queue kept the issue blocked for good.
describe('a harness run that ends without its driver', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  const dataDir = () => join(root, '.ai/cezar');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

  beforeEach(() => {
    vi.stubEnv('CEZ_MULTI_MODEL', '1');
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-claim-endings-'));
    mkdirSync(dataDir(), { recursive: true });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
    git('add', '.gitignore');
    git(...GIT_ID, 'commit', '-q', '-m', 'base');
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ skillsRepos: [], branchNaming: { enabled: false } }));
    store = RunStore.open(dataDir());
    // No free slot: a queued run stays queued, so the cancel lands on the queue branch.
    manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    vi.mocked(runHarnessDriver).mockReset();
    vi.mocked(runHarnessDriver).mockResolvedValue(null);
  });

  afterEach(() => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const claimedRun = (stage: 'pending' | 'staged') => {
    const run = store.createRun({ title: 't', workflow: workflow.name, task: 'Fix issue #642', steps: [] });
    store.updateRun(run.id, {
      status: 'running',
      workflowDef: workflow,
      harness: { profile: 'standard', workflow: workflow.name, issueId: '642' },
    });
    const ledger = createLedger({ workflow: workflow.name, requestedProfile: 'standard', subject: { kind: 'issue', id: '642', text: 'Fix issue #642' } });
    const claimed = acquireIssueClaim(root, run.id, '642', { dataDir: dataDir(), runExists: () => true });
    if (!claimed.ok) throw new Error(claimed.error);
    ledger.claim = { held: true, issueId: '642', path: claimed.claim.path };
    ledger.stage = stage === 'staged' ? { status: 'staged', prBody: 'body' } : { status: 'pending' };
    saveLedger(dataDir(), run.id, ledger);
    return { run, claimPath: claimed.claim.path };
  };

  it('releases the claim when a recovered run is cancelled from the queue', async () => {
    const { run, claimPath } = claimedRun('pending');
    await manager.recover();
    expect(store.getRun(run.id)?.status).toBe('queued');

    expect(manager.cancel(run.id)).toBe(true);

    expect(loadLedger(dataDir(), run.id)?.claim?.held).toBe(false);
    expect(existsSync(claimPath)).toBe(false);
    expect(acquireIssueClaim(root, 'fresh-run', '642', { dataDir: dataDir(), runExists: (id) => id === run.id }).ok).toBe(true);
  });

  // a resumed harness run reads its brief from the ledger, so an edit to its queued
  // prompt changed what the reviewers judge without the implementer ever seeing it.
  it('refuses prompt edits on a harness run resuming from its ledger', async () => {
    const { run } = claimedRun('pending');
    await manager.recover();
    expect(store.getRun(run.id)?.status).toBe('queued');

    expect(manager.editTask(run.id, 'A different brief')).toBe(false);
    expect(manager.enqueueMessage(run.id, [{ type: 'text', text: 'and this' }])).toBeNull();
    expect(store.getRun(run.id)?.task).toBe('Fix issue #642');
  });

  // no phase reads an attachment, so a harness start refuses one.
  it('refuses an attachment on a harness start', () => {
    expect(() =>
      manager.startRun(workflow, {
        task: 'Fix issue #642',
        images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } }],
      }),
    ).toThrow(HARNESS_TEXT_ONLY_ERROR);
  });

  it('updates the issue of an edited harness task through dequeue hydration', () => {
    const run = manager.startRun(workflow, { task: 'Fix issue #642' });
    expect(manager.editTask(run.id, 'Fix issue #999')).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ task: 'Fix issue #999', issueNumber: 999, harness: { issueId: '999' } });
    const internal = manager as unknown as {
      pendingJobs: Map<string, { input: Parameters<RunManager['startRun']>[1] }>;
      hydrateQueuedInput: (id: string, input: Parameters<RunManager['startRun']>[1]) => Parameters<RunManager['startRun']>[1];
    };
    expect(internal.hydrateQueuedInput(run.id, internal.pendingJobs.get(run.id)!.input).harness?.issueId).toBe('999');
    expect(manager.editTask(run.id, 'Fix something')).toBe(true);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('999');
  });

  it('retains an explicit issue binding through edits without a text reference', () => {
    const run = manager.startRun(workflow, { task: 'Fix the crash', harness: { issueId: '642' } });
    expect(manager.editTask(run.id, 'Fix the startup crash')).toBe(true);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('642');
    expect(manager.editTask(run.id, 'Fix issue #999')).toBe(true);
    expect(store.getRun(run.id)?.harness?.issueId).toBe('999');
  });

  it('reports a missing issue binding without editing the queued task', () => {
    const run = manager.startRun(workflow, { task: 'Fix issue #642' });
    store.updateRun(run.id, { harness: { workflow: workflow.name, profile: 'standard' } });
    expect(manager.editTask(run.id, 'Fix the crash')).toBe('missing-issue');
    expect(store.getRun(run.id)?.task).toBe('Fix issue #642');
  });

  it('guard: ordinary queued task edits still update the prompt and inferred issue', () => {
    const run = manager.startRun({ name: 'ordinary', source: 'file', steps: [{ id: 'work', prompt: '{{task}}' }] }, { task: 'old' });
    expect(manager.editTask(run.id, 'Fix issue #123')).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ task: 'Fix issue #123', issueNumber: 123 });
    expect(manager.editTask(run.id, 'new brief')).toBe(true);
    expect(store.getRun(run.id)?.task).toBe('new brief');
  });

  it('keeps the claim of a run parked on its staged handoff', async () => {
    const { run, claimPath } = claimedRun('staged');
    await manager.recover();
    expect(manager.cancel(run.id)).toBe(true);
    expect(loadLedger(dataDir(), run.id)?.claim?.held).toBe(true);
    expect(existsSync(claimPath)).toBe(true);
  });
});
