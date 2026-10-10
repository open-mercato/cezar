import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleAction, LifecycleOperationView, ScriptEntry, WorktreeLifecycleConfig } from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { WorktreeLifecycleCoordinator } from './coordinator.ts';
import { readLifecycleConfig, writeLifecycleConfig } from './config.ts';

type FakeRun = {id: string; task: string; status: string; worktreePath?: string; branch?: string; [key: string]: unknown};
const roots: string[] = [];
const coordinators: WorktreeLifecycleCoordinator[] = [];
const entry = (command: string): ScriptEntry => ({id: randomUUID(), command});
async function project(semaphore = new WorkspaceSemaphore({initial: {maxParallel: 1}})) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cez-lifecycle-git-'))); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, '.gitignore'), '.ai/cezar/\n');
  git('add', '.gitignore');
  git('-c', 'user.name=Lifecycle Test', '-c', 'user.email=lifecycle@example.invalid', 'commit', '-qm', 'fixture');
  const id = randomUUID();
  const records = new Map<string, FakeRun>([[id, {id, task: 'fixture task', status: 'running'}]]);
  const runs = {
    flush: () => undefined,
    listRuns: () => [...records.values()],
    getRun: (runId: string) => records.get(runId),
    updateRun: (runId: string, patch: Record<string, unknown>) => { const run = records.get(runId); if (run) Object.assign(run, patch); },
    deleteRun: (runId: string) => { records.delete(runId); },
  } as unknown as RunStore;
  const resume = vi.fn(async () => {});
  const coordinator = new WorktreeLifecycleCoordinator(root, runs, {semaphore, busySlots: () => 0, isActive: () => false, cancelAndWait: async () => true, resume});
  coordinators.push(coordinator);
  const config = async (afterCreate: ScriptEntry[] = [], beforeRemove: ScriptEntry[] = []) => {
    const prior = await readLifecycleConfig(root);
    await writeLifecycleConfig(root, {afterCreate, beforeRemove} satisfies WorktreeLifecycleConfig, prior.revision);
  };
  const prepare = () => coordinator.prepare(id, 'main', {kind: 'initial', runId: id});
  const action = async (operationId: string, action: LifecycleAction) => {
    const operation = await coordinator.operation(operationId);
    return coordinator.action(operationId, {action, expectedRevision: operation.revision, requestId: randomUUID()});
  };
  return {root, id, git, records, coordinator, config, prepare, action, resume, semaphore};
}
async function settled(coordinator: WorktreeLifecycleCoordinator, id: string): Promise<LifecycleOperationView> {
  let current: LifecycleOperationView | undefined;
  await vi.waitFor(async () => {
    current = await coordinator.operation(id);
    expect(['completed', 'needs_attention', 'interrupted', 'kept', 'cancelled', 'bypassed']).toContain(current.state);
    if (current.state === 'needs_attention') expect(current.allowedActions.length).toBeGreaterThan(0);
  }, {timeout: 5000, interval: 25});
  return current!;
}
beforeEach(() => { vi.stubEnv('CEZ_DRY_RUN', '0'); });
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.dispose();
    const {records} = await coordinator.store.listWorktrees();
    for (const record of records) await coordinator.store.withWorktreeLock(record.runId, async () => {});
  }
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

describe('worktree lifecycle coordinator with real Git and command fixtures', () => {
  it('runs setup before ready, reuses prepared directories, and preserves identity across reclamation', async () => {
    const p = await project();
    await p.config([entry('printf ready >> prepared')]);
    const first = await p.prepare();
    expect(first.ready).toBe(true);
    expect(await readFile(join(first.path, 'prepared'), 'utf8')).toBe('ready');
    const identity = await p.coordinator.store.readWorktree(p.id);
    expect((await p.prepare()).ready).toBe(true);
    expect(await readFile(join(first.path, 'prepared'), 'utf8')).toBe('ready');
    const removal = await p.coordinator.startRemoval({requestId: randomUUID(), runId: p.id, intent: 'reclaim'});
    expect((await settled(p.coordinator, removal.id)).state).toBe('completed');
    expect(existsSync(first.path)).toBe(false);
    expect(p.git('show-ref', '--verify', `refs/heads/${first.branch}`)).toContain(first.branch);
    expect((await p.prepare()).ready).toBe(true);
    expect(await p.coordinator.store.readWorktree(p.id)).toMatchObject({worktreeId: identity!.worktreeId, generation: 2, preparedBy: 'completed'});
    expect(await readFile(join(first.path, 'prepared'), 'utf8')).toBe('ready');
  });

  it('retries current edited/reordered commands while crediting durable unchanged successes', async () => {
    const p = await project();
    const first = entry('echo first >> trace'); const second = entry('echo failing >> trace; exit 4'); const third = entry('echo third >> trace');
    await p.config([first, second, third]);
    const prepared = await p.prepare();
    expect(prepared.ready).toBe(false);
    const initial = await p.coordinator.operation(prepared.operationId!);
    expect(initial).toMatchObject({state: 'needs_attention', allowedActions: ['retry', 'start-anyway', 'cancel-task']});
    expect(initial.history.map(item => item.state)).toEqual(['succeeded', 'failed']);
    const inserted = entry('echo inserted >> trace');
    await p.config([third, first, inserted, {...second, command: 'echo repaired >> trace'}]);
    // Saving never activates a failed operation.
    expect((await p.coordinator.operation(initial.id)).state).toBe('needs_attention');
    await p.action(initial.id, 'retry');
    expect(p.resume).toHaveBeenCalledOnce();
    expect((await p.prepare()).ready).toBe(true);
    expect(await readFile(join(prepared.path, 'trace'), 'utf8')).toBe('first\nfailing\nthird\ninserted\nrepaired\n');
    expect((await p.coordinator.operation(initial.id)).history.filter(item => item.entryId === first.id)).toHaveLength(1);
  });

  it('reruns an edited successful entry and omits removed entries on current-list retry', async () => {
    const p = await project();
    const first = entry('echo old >> trace'); const failing = entry('exit 5');
    await p.config([first, failing, entry('echo removed >> trace')]);
    const prepared = await p.prepare();
    await p.config([{...first, command: 'echo new >> trace'}]);
    await p.action(prepared.operationId!, 'retry');
    expect((await p.prepare()).ready).toBe(true);
    expect(await readFile(join(prepared.path, 'trace'), 'utf8')).toBe('old\nnew\n');
    expect((await p.coordinator.operation(prepared.operationId!)).entries.find(item => item.entryId === failing.id)?.state).toBe('removed');
  });

  it('requires explicit retry after clearing current scripts', async () => {
    const p = await project(); await p.config([entry('exit 9')]);
    const prepared = await p.prepare(); await p.config();
    expect((await p.coordinator.operation(prepared.operationId!)).state).toBe('needs_attention');
    await p.action(prepared.operationId!, 'retry');
    expect((await p.prepare()).ready).toBe(true);
    expect((await p.coordinator.operation(prepared.operationId!)).state).toBe('completed');
  });

  it('reacquires preparation from the resume callback without holding the worktree lock', async () => {
    const p = await project(); await p.config([entry('exit 4')]); const prepared = await p.prepare();
    await p.config([entry('echo repaired > resumed')]);
    p.resume.mockImplementation(async () => { await p.prepare(); });
    await p.action(prepared.operationId!, 'retry');
    expect((await settled(p.coordinator, prepared.operationId!)).state).toBe('completed');
    expect(await readFile(join(prepared.path, 'resumed'), 'utf8')).toBe('repaired\n');
  });

  it('explicit setup bypass does not require corrected templates, while cancel retains resources', async () => {
    const p = await project(); const failing = entry('echo partial > resource; exit 4');
    await p.config([failing]); const prepared = await p.prepare();
    await p.config([{...failing, command: 'echo "{{root_path}}"'}]);
    await p.action(prepared.operationId!, 'start-anyway');
    expect((await p.prepare()).ready).toBe(true);
    expect((await p.coordinator.operation(prepared.operationId!)).state).toBe('bypassed');
    expect(await readFile(join(prepared.path, 'resource'), 'utf8')).toBe('partial\n');
    const second = await project(); await second.config([entry('echo kept > resource; exit 2')]);
    const failed = await second.prepare(); await second.action(failed.operationId!, 'cancel-task');
    expect(second.records.get(second.id)?.status).toBe('cancelled');
    expect(existsSync(failed.path)).toBe(true);
    expect(await second.coordinator.store.readWorktree(second.id)).toMatchObject({autoCleanupSuppressed: true});
  });

  it('retains a worktree after failed teardown and Keep suppresses automatic reclamation', async () => {
    const p = await project(); await p.config([], [entry('echo partial > cleanup; exit 3')]);
    const prepared = await p.prepare();
    const operation = await p.coordinator.startRemoval({requestId: randomUUID(), runId: p.id, intent: 'reclaim'});
    expect((await settled(p.coordinator, operation.id)).allowedActions).toEqual(['retry', 'keep-worktree', 'force-delete']);
    expect(existsSync(prepared.path)).toBe(true);
    await p.action(operation.id, 'keep-worktree');
    expect(await p.coordinator.store.readWorktree(p.id)).toMatchObject({autoCleanupSuppressed: true});
    expect(await p.coordinator.reclaim(p.id)).toBe(false);
    expect(existsSync(prepared.path)).toBe(true);
  });

  it('Force preserves reclamation scope, while delete-task removes the record and branch', async () => {
    const p = await project(); await p.config([], [entry('exit 3')]); const prepared = await p.prepare();
    const operation = await p.coordinator.startRemoval({requestId: randomUUID(), runId: p.id, intent: 'reclaim'});
    await settled(p.coordinator, operation.id); await p.action(operation.id, 'force-delete');
    expect((await settled(p.coordinator, operation.id)).state).toBe('completed');
    expect(existsSync(prepared.path)).toBe(false); expect(p.records.has(p.id)).toBe(true);
    expect(p.git('show-ref', '--verify', `refs/heads/${prepared.branch}`)).toContain(prepared.branch);
    await p.prepare(); await p.config();
    const deletion = await p.coordinator.startRemoval({requestId: randomUUID(), runId: p.id, intent: 'delete-task'});
    expect((await settled(p.coordinator, deletion.id)).state).toBe('completed');
    expect(p.records.has(p.id)).toBe(false);
    expect(p.git('branch', '--list', prepared.branch).trim()).toBe('');
  });

  it('makes duplicate removal requests idempotent and rejects stale action revisions', async () => {
    const p = await project(); await p.config([], [entry('exit 6')]); await p.prepare();
    const request = {requestId: randomUUID(), runId: p.id, intent: 'reclaim' as const};
    const operation = await p.coordinator.startRemoval(request); const current = await settled(p.coordinator, operation.id);
    expect((await p.coordinator.startRemoval(request)).id).toBe(operation.id);
    await expect(p.coordinator.startRemoval({...request, intent: 'delete-task'})).rejects.toThrow('different action');
    await expect(p.coordinator.action(operation.id, {requestId: randomUUID(), expectedRevision: operation.revision, action: 'force-delete'})).rejects.toThrow('changed');
    const action = {requestId: randomUUID(), expectedRevision: current.revision, action: 'keep-worktree' as const};
    expect((await p.coordinator.action(operation.id, action)).state).toBe('kept');
    expect((await p.coordinator.action(operation.id, action)).state).toBe('kept');
  });

  it('rejects reusing one request ID for a different worktree in the same project', async () => {
    const p = await project(); await p.config([], [entry('exit 6')]); await p.prepare();
    const otherId = randomUUID(); p.records.set(otherId, {id: otherId, task: 'other task', status: 'done'});
    const other = await p.coordinator.prepare(otherId, 'main', {kind: 'initial', runId: otherId});
    const requestId = randomUUID();
    const first = await p.coordinator.startRemoval({requestId, runId: p.id, intent: 'reclaim'});
    await settled(p.coordinator, first.id);
    await expect(p.coordinator.startRemoval({requestId, runId: otherId, intent: 'reclaim'})).rejects.toThrow('different action');
    expect(existsSync(other.path)).toBe(true);
  });

  it('shares one admission slot across projects and releases it when scripts fail', async () => {
    const semaphore = new WorkspaceSemaphore({initial: {maxParallel: 1}});
    const a = await project(semaphore); const b = await project(semaphore);
    await a.config([], [entry('sleep 0.2; exit 2')]); await b.config([], [entry('echo cleaned')]);
    await a.prepare(); const secondPath = (await b.prepare()).path;
    const first = await a.coordinator.startRemoval({requestId: randomUUID(), runId: a.id, intent: 'reclaim'});
    await vi.waitFor(() => expect(semaphore.busy()).toBe(1));
    const second = await b.coordinator.startRemoval({requestId: randomUUID(), runId: b.id, intent: 'reclaim'});
    expect((await b.coordinator.operation(second.id)).state).toBe('queued');
    expect((await settled(a.coordinator, first.id)).state).toBe('needs_attention');
    expect((await settled(b.coordinator, second.id)).state).toBe('completed');
    await vi.waitFor(() => expect(semaphore.busy()).toBe(0));
    expect(existsSync(secondPath)).toBe(false);
  });

  it('rejects unknown identities and malformed retained context without touching the worktree', async () => {
    const p = await project(); await p.config([entry('true')]); const prepared = await p.prepare();
    await expect(p.coordinator.startRemoval({requestId: randomUUID(), worktreeId: randomUUID(), intent: 'orphan'})).rejects.toThrow('Unknown');
    const recordFile = join(p.coordinator.store.directory, 'worktrees', `${p.id}.json`);
    const record = JSON.parse(await readFile(recordFile, 'utf8'));
    await writeFile(recordFile, JSON.stringify({...record, worktreePath: p.root}));
    await expect(p.coordinator.startRemoval({requestId: randomUUID(), runId: p.id, intent: 'delete-task'})).rejects.toThrow();
    expect(existsSync(prepared.path)).toBe(true); expect(p.records.has(p.id)).toBe(true);
  });

  it('reconciles interrupted execution without rerunning it or deleting its directory', async () => {
    const p = await project(); await p.config([entry('exit 1')]); const prepared = await p.prepare();
    const operation = (await p.coordinator.store.readOperation(prepared.operationId!))!;
    await p.coordinator.store.writeOperation({...operation, revision: operation.revision + 1, state: 'running'}, operation.revision);
    await p.coordinator.reconcile();
    expect((await p.coordinator.operation(operation.id)).state).toBe('interrupted');
    expect(existsSync(prepared.path)).toBe(true); expect(p.resume).not.toHaveBeenCalled();
  });
});
