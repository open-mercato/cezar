import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { forkShape, type WorkflowGraph } from './graph.ts';

vi.mock('../git-worktree.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../git-worktree.ts')>(),
  autosaveCommit: vi.fn().mockResolvedValue({ result: 'nothing' }),
}));

const workflow: WorkflowDef = { name: '(planned)', source: 'built-in', steps: [{ id: 'task', prompt: '{{task}}' }] };
let root: string, store: RunStore, manager: RunManager;
type Runtime = {
  pump(): Promise<void>;
  agentEnvForStep: RunManager['agentEnvForStep'];
  runSystemNode: RunManager['runSystemNode'];
  runFork: RunManager['runFork'];
  awaitChildren: RunManager['awaitChildren'];
  findWorkflow: RunManager['findWorkflow'];
};
const runtime = () => manager as unknown as Runtime;
function boot() {
  manager = new RunManager(store, root);
  // Exercise real admission and persistence; keep every child queued, without a provider.
  vi.spyOn(runtime(), 'pump').mockResolvedValue();
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'deferred-child-')));
  vi.stubEnv('CEZ_HOME', join(root, 'home'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'original'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AUTONAME', '0');
  vi.stubEnv('CEZ_DISPATCH', '1');
  mkdirSync(join(root, 'original'));
  mkdirSync(join(root, 'changed'));
  store = RunStore.open(join(root, 'state'), { keepLive: true });
  boot();
});
afterEach(() => {
  manager.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function parent() {
  const run = store.createRun({ task: 'scheduled', title: 'scheduled', workflow: 'parent', runner: 'claude', steps: [{ id: 'first', name: 'First', kind: 'agent' }] });
  store.updateRun(run.id, { status: 'queued', workflowDef: workflow, deferredBinding: {
    revision: 'confirmed', runner: 'claude',
    accounts: [{ runner: 'claude', id: 'default', path: join(root, 'original') }],
  } });
  return run;
}
function child(parentId: string, def?: WorkflowDef): RunRecord {
  const result = manager.dispatch(parentId, { objective: 'child' }, def ? { workflow: def } : {});
  if ('refused' in result) throw new Error(result.refused);
  return store.getRun(result.id)!;
}
async function restart() {
  manager.dispose(); store.flush();
  store = RunStore.open(join(root, 'state'), { keepLive: true }); boot();
  await manager.recover();
}

it.each(['dispatch', 'fork branch', 'subworkflow'] as const)('guards a queued %s child after restart without reusing the scheduled identity', async kind => {
  const scheduled = parent();
  vi.spyOn(runtime(), 'awaitChildren').mockResolvedValue('finished');
  vi.spyOn(runtime(), 'findWorkflow').mockResolvedValue(workflow);
  const state = { cwd: root } as Parameters<Runtime['runSystemNode']>[1];
  const outputs = new Map<string, Record<string, string | number>>();
  if (kind === 'fork branch') {
    const fork = { id: 'fork', type: 'fork' as const, branches: 2 };
    const graph: WorkflowGraph = {
      nodes: [fork, { id: 'agent', type: 'agent', prompt: '{{task}}' }, { id: 'second', type: 'agent', prompt: '{{task}}' }, { id: 'join', type: 'join', wait: 'all' }],
      edges: [{ from: 'fork.1', to: 'agent' }, { from: 'agent', to: 'join' }, { from: 'fork.2', to: 'second' }, { from: 'second', to: 'join' }],
    };
    const shape = forkShape(graph, 'fork');
    if (typeof shape === 'string') throw new Error(shape);
    await runtime().runFork(graph, scheduled.id, state, fork, shape, outputs, 'task', () => {}, () => {}, false);
  } else {
    const node = kind === 'dispatch'
      ? { id: 'child', type: 'dispatch' as const, prompt: '{{task}}' }
      : { id: 'child', type: 'workflow' as const, workflow: workflow.name };
    await runtime().runSystemNode(scheduled.id, state, node, outputs, 'task', () => {});
  }
  const admitted = store.listRuns().filter(run => run.dispatch?.parentRunId === scheduled.id);
  expect(admitted).toHaveLength(kind === 'fork branch' ? 2 : 1);
  for (const run of admitted) {
    expect(run.id).not.toBe(scheduled.id);
    expect(run.automationTrigger).toBeUndefined();
    expect(run.status).toBe('queued');
    await expect(runtime().agentEnvForStep(run.id, 'claude')).resolves.toBeDefined();
  }
  await restart();
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'changed'));
  for (const run of admitted) {
    expect(store.getRun(run.id)?.status).toBe('queued');
    await expect(runtime().agentEnvForStep(run.id, 'claude')).rejects.toThrow('Scheduled account binding changed');
    expect(store.getRun(run.id)?.deferredBinding).toEqual(scheduled.deferredBinding);
  }
});

it('carries the guard through nested declarative admissions before any agent starts', async () => {
  const scheduled = parent();
  const nested = child(scheduled.id, workflow);
  const leaf = child(nested.id);
  await restart();
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'changed'));
  await expect(runtime().agentEnvForStep(leaf.id, 'claude')).rejects.toThrow('Scheduled account binding changed');
});

it('later child steps and children dispatched after an inline agent resolve normally', async () => {
  const scheduled = parent();
  const first = child(scheduled.id);
  store.updateStep(first.id, 'task', { profileId: 'default' });
  store.updateStep(scheduled.id, 'first', { profileId: 'default' });
  const later = child(scheduled.id);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'changed'));
  await expect(runtime().agentEnvForStep(first.id, 'claude')).resolves.toBeDefined();
  await expect(runtime().agentEnvForStep(later.id, 'claude')).resolves.toBeDefined();
  expect(later.deferredBinding).toBeUndefined();
});

it('a completed child session releases the parent and subsequent declarative steps after restart', async () => {
  const scheduled = parent();
  const first = child(scheduled.id);
  store.updateStep(first.id, 'task', { profileId: 'default' });
  store.updateRun(first.id, { status: 'done' });
  await restart();
  const later = child(scheduled.id);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'changed'));
  await expect(runtime().agentEnvForStep(scheduled.id, 'claude')).resolves.toBeDefined();
  await expect(runtime().agentEnvForStep(later.id, 'claude')).resolves.toBeDefined();
  expect(later.deferredBinding).toBeUndefined();
});

it('an unrelated launched tree and a launched fork sibling cannot release a queued child guard', async () => {
  const unrelated = parent();
  store.updateStep(unrelated.id, 'first', { profileId: 'default' });
  const scheduled = parent();
  const first = child(scheduled.id);
  const sibling = child(scheduled.id);
  store.updateStep(first.id, 'task', { profileId: 'default' });
  await restart();
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'changed'));
  await expect(runtime().agentEnvForStep(sibling.id, 'claude')).rejects.toThrow('Scheduled account binding changed');
});
