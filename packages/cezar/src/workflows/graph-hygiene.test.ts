import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import type { WorkflowDef } from './types.ts';

const GRAPH: WorkflowGraph = {
  nodes: [{ id: 'start', type: 'start' }, { id: 'sub', type: 'dispatch', prompt: 'mock:monitoring wait for owner' },
    { id: 'after', type: 'check', command: `node -e "require('fs').writeFileSync('after.txt','continued')"` }],
  edges: [{ from: 'start', to: 'sub' }, { from: 'sub.done', to: 'after' }],
};
const WORKFLOW: WorkflowDef = { name: 'hygiene-procedure', source: 'file', graph: GRAPH, steps: graphToSteps(GRAPH) };
describe('sessionless workflow hygiene', () => {
  let root: string, store: RunStore, manager: RunManager, dry: string | undefined;
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('workflow did not reach expected state'); await new Promise(r => setTimeout(r, 25)); }
  };
  beforeEach(() => {
    dry = process.env.CEZ_DRY_RUN; process.env.CEZ_DRY_RUN = '1';
    root = mkdtempSync(join(tmpdir(), 'cez-graph-hygiene-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.ai/\n'); writeFileSync(join(root, 'base'), 'base');
    execFileSync('git', ['add', 'base', '.gitignore'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar')); manager = new RunManager(store, root);
  });
  afterEach(async () => {
    for (const run of store.listRuns()) manager.cancel(run.id);
    manager.dispose(); await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    vi.unstubAllEnvs();
    store.flush(); rmSync(root, { recursive: true, force: true });
    if (dry === undefined) delete process.env.CEZ_DRY_RUN; else process.env.CEZ_DRY_RUN = dry;
  });
  it('prepares one handoff in the same live workflow, retains reports, then resumes its original checkpoint', async () => {
    const id = manager.startRun(WORKFLOW, { task: 'procedure', worktree: false }).id;
    await until(() => (manager as any).active.get(id)?.graphChildWaits?.size > 0);
    const child = store.listRuns().find(run => run.dispatch?.parentRunId === id)!;
    await until(() => store.getRun(child.id)?.activity === 'monitoring');
    store.updateRun(id, { threadHygiene: { continuations: 3, historyKnown: true } });
    manager.finish(child.id);
    await until(() => !!store.getRun(id)?.threadHygiene?.pending);
    const count = store.listRuns().length;
    expect(manager.resumeThreadHygiene(id, { action: 'handoff', expectedCount: 3 }, [{ type: 'text', text: 'mock:done prepare a handoff only' }]).ok).toBe(true);
    await until(() => store.getRun(id)?.threadHygiene?.pending?.reason === 'handoff-review' && !manager.isActive(id));
    const prepared = store.getRun(id)!;
    expect(prepared.status).toBe('waiting'); expect(prepared.graphState?.cursor).toBe('sub');
    expect(prepared.threadHygiene?.continuations).toBe(4); expect(store.listRuns()).toHaveLength(count);
    expect(prepared.dispatch?.pendingReports?.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'after.txt'))).toBe(false);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 4 }, [{ type: 'text', text: 'continue' }]).ok).toBe(true);
    await until(() => ['done', 'review', 'failed'].includes(store.getRun(id)?.status ?? ''));
    expect(store.getRun(id)?.status).not.toBe('failed'); expect(readFileSync(join(root, 'after.txt'), 'utf8')).toBe('continued');
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(5); expect(store.listRuns()).toHaveLength(count);
  }, 45000);
  const restore = async () => {
    const run = store.createRun({ title: 'Restored graph', workflow: WORKFLOW.name, task: 'procedure', worktree: false, steps: graphToSteps(GRAPH).map(s => ({ id: s.id, name: s.name ?? s.id, kind: 'agent' })) });
    const child = store.createRun({ title: 'Finished child', workflow: 'quick-task', task: 'result', steps: [] });
    store.updateRun(child.id, { status: 'done', finishedAt: new Date().toISOString(), dispatch: { parentRunId: run.id, rootRunId: run.id } });
    store.updateStep(run.id, 'sub', { status: 'waiting' });
    store.updateRun(run.id, { status: 'running', workflowDef: WORKFLOW, graphState: { cursor: 'sub', loops: {}, taken: [], outputs: { sub: { runId: child.id } } }, dispatch: { rootRunId: run.id },
      threadHygiene: { continuations: 3, historyKnown: true, pending: { reason: 'child-report', since: new Date().toISOString() } } });
    await manager.recover(); return run.id;
  };
  it('restores a checkpoint without an agent session and executes nothing until explicit Continue', async () => {
    const id = await restore(); expect(manager.isActive(id)).toBe(false); expect(existsSync(join(root, 'after.txt'))).toBe(false);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 3 }, [{ type: 'text', text: 'continue' }]).ok).toBe(true);
    await until(() => ['done', 'review', 'failed'].includes(store.getRun(id)?.status ?? ''));
    expect(store.getRun(id)?.status).not.toBe('failed'); expect(readFileSync(join(root, 'after.txt'), 'utf8')).toBe('continued');
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4); expect(store.listRuns()).toHaveLength(2);
  }, 30000);
  it('prepares a handoff after restart without starting the next workflow step', async () => {
    const id = await restore();
    expect(manager.resumeThreadHygiene(id, { action: 'handoff', expectedCount: 3 }, [{ type: 'text', text: 'mock:done prepare handoff' }]).ok).toBe(true);
    await until(() => store.getRun(id)?.threadHygiene?.pending?.reason === 'handoff-review' && !manager.isActive(id));
    expect(store.getRun(id)?.status).toBe('waiting'); expect(store.getRun(id)?.graphState?.cursor).toBe('sub');
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4); expect(existsSync(join(root, 'after.txt'))).toBe(false);
    expect(store.listRuns()).toHaveLength(2);
  }, 30000);
  it('parks an interrupted preparation at recovery without buying another turn', async () => {
    const id = await restore();
    store.updateRun(id, { status: 'running', threadHygiene: { continuations: 4, historyKnown: true, graphPaused: true, preparingHandoff: true,
      pending: { reason: 'preparing-handoff', since: new Date().toISOString() } } });
    await manager.recover();
    expect(manager.isActive(id)).toBe(false); expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.idleClosedAt).toBeTruthy();
    expect(store.getRun(id)?.threadHygiene).toMatchObject({ continuations: 4, graphPaused: true, preparingHandoff: false });
    expect(existsSync(join(root, 'after.txt'))).toBe(false);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 4 }, [{ type: 'text', text: 'continue' }]).ok).toBe(true);
    await until(() => ['done', 'review', 'failed'].includes(store.getRun(id)?.status ?? ''));
    expect(readFileSync(join(root, 'after.txt'), 'utf8')).toBe('continued'); expect(store.listRuns()).toHaveLength(2);
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(5);
  }, 30000);
  it('holds a failed preparation for a human decision instead of retrying or failing the workflow', async () => {
    const id = await restore();
    expect(manager.resumeThreadHygiene(id, { action: 'handoff', expectedCount: 3 }, [{ type: 'text', text: 'mock:credit' }]).ok).toBe(true);
    await until(() => store.getRun(id)?.threadHygiene?.pending?.reason === 'handoff-failed' && !manager.isActive(id));
    expect(store.getRun(id)?.status).toBe('waiting'); expect(store.getRun(id)?.error).toMatch(/credit/i);
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4); expect(existsSync(join(root, 'after.txt'))).toBe(false);
    expect((manager as any).autoResumeTimers.size).toBe(0);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 4 }, [{ type: 'text', text: 'continue' }]).ok).toBe(true);
    await until(() => ['done', 'review', 'failed'].includes(store.getRun(id)?.status ?? ''));
    expect(readFileSync(join(root, 'after.txt'), 'utf8')).toBe('continued');
  }, 30000);
  it('rejects a second decision while preparation runs and preserves runner selection rules', async () => {
    const id = await restore();
    store.updateRun(id, { runner: 'claude', model: 'opus', agentProfile: 'old-account', reasoningEffort: 'high' });
    expect(manager.resumeThreadHygiene(id, { action: 'handoff', expectedCount: 3 }, [{ type: 'text', text: 'mock:pause mock:done prepare' }], { runner: 'codex' }).ok).toBe(true);
    const picked = store.getRun(id)!; expect(picked.runner).toBe('codex'); expect(picked.model).toBeUndefined();
    expect(picked.agentProfile).toBeUndefined(); expect(picked.reasoningEffort).toBeUndefined();
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 4 }, [{ type: 'text', text: 'continue' }]).ok).toBe(false);
    await until(() => store.getRun(id)?.threadHygiene?.pending?.reason === 'handoff-review' && !manager.isActive(id));
    expect(existsSync(join(root, 'after.txt'))).toBe(false); expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4);
  }, 30000);

  it.each(['all', 'any'] as const)('preserves a parallel %s checkpoint, children and reports through preparation', async mode => {
    const graph: WorkflowGraph = { nodes: [{ id: 'start', type: 'start' }, { id: 'fork', type: 'fork', branches: 2 },
      { id: 'one', type: 'agent', prompt: 'mock:monitoring one' }, { id: 'two', type: 'agent', prompt: 'mock:monitoring two' },
      { id: 'join', type: 'join', wait: mode }, GRAPH.nodes[2]!], edges: [{ from: 'start', to: 'fork' },
      { from: 'fork.1', to: 'one' }, { from: 'fork.2', to: 'two' }, { from: 'one.done', to: 'join' },
      { from: 'two.done', to: 'join' }, { from: 'join.done', to: 'after' }] };
    const id = manager.startRun({ ...WORKFLOW, graph, steps: graphToSteps(graph) }, { task: 'parallel procedure', worktree: false }).id;
    await until(() => (manager as any).active.get(id)?.graphChildWaits?.size === 2);
    const children = store.listRuns().filter(run => run.dispatch?.parentRunId === id);
    await until(() => children.every(child => store.getRun(child.id)?.activity === 'monitoring'));
    store.updateRun(id, { threadHygiene: { continuations: 3, historyKnown: true } });
    manager.finish(children[0]!.id);
    if (mode === 'all') manager.finish(children[1]!.id);
    await until(() => !!store.getRun(id)?.threadHygiene?.pending);
    expect(manager.resumeThreadHygiene(id, { action: 'handoff', expectedCount: 3 }, [{ type: 'text', text: 'mock:pause mock:done prepare only' }]).ok).toBe(true);
    if (mode === 'any') {
      expect(store.getRun(children[1]!.id)?.status).not.toBe('cancelled');
      manager.finish(children[1]!.id);
    }
    await until(() => store.getRun(id)?.threadHygiene?.pending?.reason === 'handoff-review' && !manager.isActive(id));
    expect(store.getRun(id)?.graphState?.cursor).toBe('fork'); expect(store.listRuns()).toHaveLength(3);
    expect(store.getRun(id)?.dispatch?.pendingReports?.length).toBeGreaterThan(0);
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4); expect(existsSync(join(root, 'after.txt'))).toBe(false);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 4 }, [{ type: 'text', text: 'continue' }]).ok).toBe(true);
    await until(() => ['done', 'review', 'failed'].includes(store.getRun(id)?.status ?? ''));
    expect(store.getRun(id)?.status).not.toBe('failed'); expect(store.listRuns()).toHaveLength(3);
    expect(readFileSync(join(root, 'after.txt'), 'utf8')).toBe('continued'); expect(store.getRun(id)?.threadHygiene?.continuations).toBe(5);
  }, 45000);

  it('passes a custom Continue instruction into the next live workflow step', async () => {
    const graph: WorkflowGraph = { ...GRAPH, nodes: [...GRAPH.nodes.slice(0, 2),
      { id: 'after', type: 'agent', prompt: '{{task}} mock:done' }] };
    const inbound = join(root, 'inbound.jsonl'); vi.stubEnv('CEZ_MOCK_STDIN_FILE', inbound);
    const id = manager.startRun({ ...WORKFLOW, graph, steps: graphToSteps(graph) }, { task: 'original procedure', worktree: false }).id;
    await until(() => (manager as any).active.get(id)?.graphChildWaits?.size > 0);
    const child = store.listRuns().find(run => run.dispatch?.parentRunId === id)!;
    await until(() => store.getRun(child.id)?.activity === 'monitoring');
    store.updateRun(id, { threadHygiene: { continuations: 3, historyKnown: true } }); manager.finish(child.id);
    await until(() => !!store.getRun(id)?.threadHygiene?.pending);
    expect(manager.resumeThreadHygiene(id, { action: 'continue', expectedCount: 3 }, [{ type: 'text', text: 'use the selected early mockup' }]).ok).toBe(true);
    await until(() => ['done', 'review', 'failed'].includes(store.getRun(id)?.status ?? ''));
    expect(readFileSync(inbound, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).userText).some(text => text.includes('use the selected early mockup'))).toBe(true);
    expect(store.getRun(id)?.threadHygiene?.continuations).toBe(4); expect(store.listRuns()).toHaveLength(2);
  }, 30000);

});
