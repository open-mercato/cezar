import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { loadWorkflows, newerCatalogWorkflow } from './load.ts';
import { RunManager } from './run.ts';
import { QUICK_TASK_WORKFLOW, type WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const ONE_STEP = `name: demo
steps:
  - id: task
    name: Do the task
    prompt: "{{task}}"
`;
const TWO_STEPS = `${ONE_STEP}  - id: wrapup
    name: WRAPUP-STEP added while runs were queued
    prompt: "mock:done"
`;

/**
 * #1078 — a queued run starts with the workflow as it is when it leaves the queue, not as it was
 * when the run was created. One workspace slot holds the second run in the queue while its
 * workflow file changes on disk; the mock backend's `notes.md` proves which steps really ran.
 */
describe('a queued run re-resolves its workflow at dequeue (#1078)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const workflowFile = () => join(repoRoot, '.ai/cezar/workflows', 'demo.yaml');

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-1078-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar/workflows'), { recursive: true });
    writeFileSync(workflowFile(), ONE_STEP);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
  });

  afterEach(() => {
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const demo = async (): Promise<WorkflowDef> => {
    const found = (await loadWorkflows(repoRoot)).workflows.find((w) => w.name === 'demo');
    if (!found) throw new Error('demo workflow did not load');
    return found;
  };

  /** Occupy the only slot with a run that has already STARTED, then queue the run under test
   *  behind it — so an edit made afterwards can only reach the queued one. */
  const queueBehindOne = async (workflow: WorkflowDef, task: string): Promise<{ first: string; queued: string }> => {
    const first = manager.startRun(workflow, { task: 'mock:done occupy the slot', worktree: false });
    const deadline = Date.now() + 20_000;
    while (store.getRun(first.id)?.status === 'queued') {
      if (Date.now() > deadline) throw new Error('first run never started');
      await new Promise((r) => setTimeout(r, 20));
    }
    const queued = manager.startRun(workflow, { task, worktree: false });
    expect(store.getRun(queued.id)?.status).toBe('queued');
    return { first: first.id, queued: queued.id };
  };

  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 40_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('queued run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** How many sessions the mock backend saw for the added step. */
  const wrapupSessions = (): number =>
    readFileSync(join(repoRoot, 'notes.md'), 'utf8').split('\n').filter((line) => line.includes('WRAPUP-STEP')).length;

  it('runs a step added to the workflow file while the run was queued', async () => {
    const { first, queued: id } = await queueBehindOne(await demo(), 'mock:done QUEUED-RUN');
    writeFileSync(workflowFile(), TWO_STEPS);

    await settle(first);
    await settle(id);

    const record = store.getRun(id);
    expect(record?.status).not.toBe('failed');
    expect(record?.steps.map((s) => s.id)).toEqual(['task', 'wrapup']);
    expect(record?.workflowDef?.steps.map((s) => s.id)).toEqual(['task', 'wrapup']);
    // The added step reached the backend once — for the queued run, not the one already running.
    expect(wrapupSessions()).toBe(1);
    expect(store.getRun(first)?.steps.map((s) => s.id)).toEqual(['task']);
    expect(store.readEvents(id).some((e) => e.type === 'lifecycle' && String(e.message).includes('changed while the task was queued'))).toBe(true);
  }, 60_000);

  it('runs its snapshot, silently, when the file did not change', async () => {
    const { queued: id } = await queueBehindOne(await demo(), 'mock:done QUEUED-RUN');

    await settle(id);

    expect(store.getRun(id)?.steps.map((s) => s.id)).toEqual(['task']);
    expect(store.readEvents(id).some((e) => String(e.message ?? '').includes('changed while the task was queued'))).toBe(false);
  }, 60_000);

  it('runs its snapshot when the workflow file was deleted while queued', async () => {
    const { queued: id } = await queueBehindOne(await demo(), 'mock:done QUEUED-RUN');
    unlinkSync(workflowFile());

    await settle(id);

    expect(store.getRun(id)?.status).not.toBe('failed');
    expect(store.getRun(id)?.steps.map((s) => s.id)).toEqual(['task']);
  }, 60_000);

  it('never replaces an ad-hoc "(planned)" chain with a file of the same name', async () => {
    const planned: WorkflowDef = {
      name: '(planned)',
      source: 'built-in',
      steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
    };
    const { queued: id } = await queueBehindOne(planned, 'mock:done PLANNED-RUN');
    writeFileSync(workflowFile(), TWO_STEPS.replace('name: demo', 'name: "(planned)"'));

    await settle(id);

    expect(store.getRun(id)?.steps.map((s) => s.id)).toEqual(['task']);
    expect(store.getRun(id)?.workflowDef?.steps.map((s) => s.id)).toEqual(['task']);
    expect(wrapupSessions()).toBe(0);
  }, 60_000);

  it('refreshes a run recovered after a restart, whose snapshot came from runs.json', async () => {
    // A run left `queued` by the previous process, its definition persisted the way startRun does.
    const stale = await demo();
    const { id } = store.createRun({
      title: 't',
      workflow: 'demo',
      task: 'mock:done RECOVERED-RUN',
      worktree: false,
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: stale });
    writeFileSync(workflowFile(), TWO_STEPS);

    // Restart the way the product does: flush `runs.json`, drop this process's store and manager,
    // reopen from disk with live rows kept, and recover into a fresh manager.
    store.flush();
    manager.dispose();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
    expect(store.getRun(id)?.status).toBe('queued');
    expect(store.getRun(id)?.workflowDef?.steps.map((s) => s.id)).toEqual(['task']);

    await manager.recover();
    await settle(id);
    store.flush();

    expect(store.getRun(id)?.steps.map((s) => s.id)).toEqual(['task', 'wrapup']);
    expect(wrapupSessions()).toBe(1);
    const persisted = JSON.parse(readFileSync(join(repoRoot, '.ai/cezar', 'runs.json'), 'utf8')) as unknown;
    const rows = (Array.isArray(persisted) ? persisted : (persisted as { runs: unknown[] }).runs) as Array<{
      id: string;
      workflowDef?: WorkflowDef;
      steps: Array<{ id: string }>;
    }>;
    const row = rows.find((r) => r.id === id);
    expect(row?.workflowDef?.steps.map((s) => s.id)).toEqual(['task', 'wrapup']);
    expect(row?.steps.map((s) => s.id)).toEqual(['task', 'wrapup']);
  }, 60_000);

  it('never rewrites the steps of a run that already started one', () => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'demo',
      task: 'x',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateStep(id, 'task', { status: 'running', iterations: 1 });

    expect(store.replacePendingSteps(id, [{ id: 'other', name: 'Other', kind: 'agent' }])).toBe(false);
    expect(store.getRun(id)?.steps.map((s) => s.id)).toEqual(['task']);
  });
});

describe('a file override of quick-task that disappears keeps the queued snapshot (#1078)', () => {
  let repoRoot: string;
  const overrideFile = () => join(repoRoot, '.ai/cezar/workflows', 'quick-task.yaml');
  const OVERRIDE = `name: quick-task
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
  - id: verify
    name: Verify
    prompt: "check it"
`;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-1078-qt-'));
    mkdirSync(join(repoRoot, '.ai/cezar/workflows'), { recursive: true });
    writeFileSync(overrideFile(), OVERRIDE);
  });

  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  const queuedSnapshot = async (): Promise<WorkflowDef> => {
    const found = (await loadWorkflows(repoRoot)).workflows.find((w) => w.name === 'quick-task');
    expect(found?.source).toBe('file');
    expect(found?.steps.map((s) => s.id)).toEqual(['implement', 'verify']);
    // Through the persisted schema, as recover() would read it back from runs.json.
    return JSON.parse(JSON.stringify(found)) as WorkflowDef;
  };

  it('keeps the file snapshot when the override file is deleted', async () => {
    const snapshot = await queuedSnapshot();
    unlinkSync(overrideFile());
    const { workflows } = await loadWorkflows(repoRoot);
    expect(workflows.find((w) => w.name === 'quick-task')?.source).toBe('built-in');

    expect(newerCatalogWorkflow(snapshot, workflows)).toBeUndefined();
  });

  it('keeps the file snapshot when the override file becomes invalid', async () => {
    const snapshot = await queuedSnapshot();
    writeFileSync(overrideFile(), 'name: quick-task\nsteps: not-a-list\n');
    const { workflows, issues } = await loadWorkflows(repoRoot);
    expect(issues).toHaveLength(1);
    expect(workflows.find((w) => w.name === 'quick-task')?.source).toBe('built-in');

    expect(newerCatalogWorkflow(snapshot, workflows)).toBeUndefined();
  });

  it('still refreshes a file snapshot when the override file changed', async () => {
    const snapshot = await queuedSnapshot();
    writeFileSync(overrideFile(), OVERRIDE.replace('check it', 'check it twice'));
    const { workflows } = await loadWorkflows(repoRoot);

    expect(newerCatalogWorkflow(snapshot, workflows)?.steps[1]?.prompt).toBe('check it twice');
  });

  it('still refreshes a built-in quick-task snapshot, including to a new file override', async () => {
    const builtIn: WorkflowDef = { ...QUICK_TASK_WORKFLOW, steps: [{ id: 'old', name: 'Old', prompt: '{{task}}' }] };
    const catalog = [QUICK_TASK_WORKFLOW];
    expect(newerCatalogWorkflow(builtIn, catalog)).toBe(QUICK_TASK_WORKFLOW);
    expect(newerCatalogWorkflow(QUICK_TASK_WORKFLOW, catalog)).toBeUndefined();

    const { workflows } = await loadWorkflows(repoRoot);
    expect(newerCatalogWorkflow(QUICK_TASK_WORKFLOW, workflows)?.steps.map((s) => s.id)).toEqual(['implement', 'verify']);
  });
});
