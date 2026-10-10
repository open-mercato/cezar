import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { readLifecycleConfig, writeLifecycleConfig } from '../worktree-lifecycle/config.ts';
import { WorktreeLifecycleCoordinator } from '../worktree-lifecycle/coordinator.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const workflow: WorkflowDef = { name: 'quick-task', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
const projects: { root: string; manager: RunManager; store: RunStore }[] = [];
let launched: AgentRunSpec[];
let launchCheck: ((spec: AgentRunSpec) => void) | undefined;
let semaphore: WorkspaceSemaphore;

async function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-lifecycle-manager-')));
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.ai/cezar/\n');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, { semaphore });
  const result = { root, store, manager }; projects.push(result); return result;
}
const entry = (command: string) => ({ id: randomUUID(), command, timeoutSeconds: 5 });
const wait = (condition: () => void) => vi.waitFor(condition, { timeout: 12_000, interval: 25 });

beforeEach(() => {
  launched = []; launchCheck = undefined;
  semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
  vi.stubEnv('CEZ_DRY_RUN', '0');
  vi.stubEnv('CEZ_AUTONAME', '0');
  vi.stubEnv('CEZ_TITLE_UPDATES', '0');
  vi.stubEnv('CEZ_REVIEW_GATE', '0');
  vi.spyOn(ClaudeCliRunner.prototype, 'startSession').mockImplementation(spec => {
    launched.push(spec); launchCheck?.(spec);
    return { result: Promise.resolve({ text: 'Fixture task completed', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId ?? randomUUID() }), open: false, sendMessage: () => false, end: () => undefined, interrupt: () => undefined } satisfies AgentSession;
  });
});
afterEach(async () => {
  for (const { manager, store } of projects) {
    for (const run of store.listRuns()) if (manager.isActive(run.id)) manager.cancel(run.id);
    manager.dispose(); store.flush();
    for (const record of (await manager.lifecycle.store.listWorktrees()).records) await manager.lifecycle.store.withWorktreeLock(record.runId, async () => {});
  }
  // Disposal stops shell children asynchronously; never delete their cwd before quiescence.
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const { root } of projects) rmSync(root, { recursive: true, force: true });
  projects.length = 0; vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('RunManager worktree lifecycle admission', () => {
  it('starts no agent until setup completed in its isolated worktree', async () => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('touch {{ root_path }}/setup-started; while [ ! -e {{ root_path }}/release ]; do sleep 0.02; done; printf prepared > setup-ready')], beforeRemove: [] }, null);
    launchCheck = spec => expect(readFileSync(join(spec.cwd, 'setup-ready'), 'utf8')).toBe('prepared');
    const run = p.manager.startRun(workflow, { task: 'original task', runner: 'claude' });
    await wait(() => expect(existsSync(join(p.root, 'setup-started'))).toBe(true));
    expect(launched).toHaveLength(0);
    expect(p.store.getRun(run.id)?.steps[0]?.sessionId).toBeUndefined();
    writeFileSync(join(p.root, 'release'), 'go');
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('done'));
    expect(launched).toHaveLength(1);
    expect(launched[0]?.cwd).toBe(join(p.root, '.ai/cezar/worktrees', run.id));
    expect((await p.manager.lifecycle.store.readWorktree(run.id))?.preparedBy).toBe('completed');
  });

  it('parks failed setup without a session, frees the workspace slot, and Retry launches the original input once', async () => {
    const p = await project(); const other = await project();
    const script = entry('exit 23');
    await writeLifecycleConfig(p.root, { afterCreate: [script], beforeRemove: [] }, null);
    const run = p.manager.startRun(workflow, { task: 'preserve this original task exactly', runner: 'claude' });
    const sibling = other.manager.startRun(workflow, { task: 'unrelated project proceeds', runner: 'claude', worktree: false });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('waiting'));
    await wait(() => expect(other.store.getRun(sibling.id)?.status).toBe('done'));
    expect(p.manager.isActive(run.id)).toBe(false);
    expect(semaphore.busy()).toBe(0);
    expect(p.store.getRun(run.id)?.steps[0]?.sessionId).toBeUndefined();
    expect(p.manager.continueRun(run.id).ok).toBe(false);
    expect(p.manager.sendMessage(run.id, [{ type: 'text', text: 'must not bypass setup' }])).toBe(false);
    expect(launched).toHaveLength(1);
    const saved = await readLifecycleConfig(p.root);
    await writeLifecycleConfig(p.root, { afterCreate: [{ ...script, command: 'printf ready > setup-ready' }], beforeRemove: [] }, saved.revision);
    const opId = p.store.getRun(run.id)!.worktreeLifecycle!.activeOperationId!;
    const operation = await p.manager.lifecycle.store.readOperation(opId);
    await p.manager.lifecycle.action(opId, { requestId: randomUUID(), expectedRevision: operation!.revision, action: 'retry' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('done'));
    expect(launched).toHaveLength(2);
    expect(launched[1]?.userPrompt).toContain('preserve this original task exactly');
    expect(launched[1]?.userPrompt).not.toContain('must not bypass');
    expect(p.store.getRun(run.id)?.steps).toHaveLength(1);
    expect(readFileSync(join(launched[1]!.cwd, 'setup-ready'), 'utf8')).toBe('ready');
  });

  it('cancel after partial setup retains the directory/resources and suppresses automatic reclamation', async () => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('printf resource > resource; exit 7')], beforeRemove: [] }, null);
    const run = p.manager.startRun(workflow, { task: 'cancel setup', runner: 'claude' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('waiting'));
    const record = await p.manager.lifecycle.store.readWorktree(run.id);
    const op = await p.manager.lifecycle.store.readOperation(record!.activeOperationId!);
    await p.manager.lifecycle.action(op!.id, { requestId: randomUUID(), expectedRevision: op!.revision, action: 'cancel-task' });
    expect(p.store.getRun(run.id)?.status).toBe('cancelled');
    expect(readFileSync(join(record!.worktreePath, 'resource'), 'utf8')).toBe('resource');
    expect(await p.manager.lifecycle.store.readWorktree(run.id)).toMatchObject({ autoCleanupSuppressed: true });
    expect(launched).toHaveLength(0);
    expect(semaphore.busy()).toBe(0);
  });

  it('keeps malformed current configuration from authorizing cleanup of a managed worktree', async () => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('exit 9')], beforeRemove: [entry('touch cleanup-ran')] }, null);
    const run = p.manager.startRun(workflow, { task: 'config repair', runner: 'claude' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('waiting'));
    const record = await p.manager.lifecycle.store.readWorktree(run.id);
    writeFileSync(join(p.root, '.ai/cezar/config.json'), '{malformed');
    expect(await p.manager.lifecycle.requiresGate(run.id)).toBe(true);
    await expect(readLifecycleConfig(p.root)).rejects.toThrow('malformed');
    await p.manager.lifecycle.reclaim(run.id);
    expect(existsSync(record!.worktreePath)).toBe(true);
    expect(existsSync(join(record!.worktreePath, 'cleanup-ran'))).toBe(false);
    expect(launched).toHaveLength(0);
  });

  it('reconstructs a parked setup after restart without launching an agent until explicit Retry', async () => {
    const p = await project();
    const script = entry('exit 17');
    await writeLifecycleConfig(p.root, { afterCreate: [script], beforeRemove: [] }, null);
    const run = p.manager.startRun(workflow, { task: 'same task after restart', runner: 'claude' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('waiting'));
    const operationId = p.store.getRun(run.id)!.worktreeLifecycle!.activeOperationId!;
    p.manager.dispose(); p.store.flush();
    p.store = RunStore.open(join(p.root, '.ai/cezar'), { keepLive: true });
    p.manager = new RunManager(p.store, p.root, { semaphore });
    await p.manager.recover();
    expect(p.store.getRun(run.id)?.status).toBe('waiting');
    expect(p.store.getRun(run.id)?.worktreeLifecycle?.activeOperationId).toBe(operationId);
    expect(launched).toHaveLength(0);
    const config = await readLifecycleConfig(p.root);
    await writeLifecycleConfig(p.root, { afterCreate: [], beforeRemove: [] }, config.revision);
    expect(launched).toHaveLength(0); // Saving alone is not a recovery action.
    const operation = await p.manager.lifecycle.store.readOperation(operationId);
    await p.manager.lifecycle.action(operationId, { requestId: randomUUID(), expectedRevision: operation!.revision, action: 'retry' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('done'));
    expect(launched).toHaveLength(1);
    expect(launched[0]?.userPrompt).toContain('same task after restart');
  });

  it('gates rematerialized continuation and preserves its original session and message across Retry', async () => {
    const p = await project();
    const script = entry('printf first > prepared');
    await writeLifecycleConfig(p.root, { afterCreate: [script], beforeRemove: [] }, null);
    const run = p.manager.startRun(workflow, { task: 'initial task', runner: 'claude' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('done'));
    await wait(() => expect(p.manager.isActive(run.id)).toBe(false));
    const firstRecord = await p.manager.lifecycle.store.readWorktree(run.id);
    const originalSessionId = launched[0]!.sessionId;
    // Exercise the actual reclamation boundary: directory gone, retained branch and task.
    p.manager.lifecycle.start();
    const removal = await p.manager.lifecycle.startRemoval({ requestId: randomUUID(), runId: run.id, intent: 'reclaim' });
    await vi.waitFor(async () => expect((await p.manager.lifecycle.operation(removal.id)).state).toBe('completed'), { timeout: 12_000, interval: 25 });
    expect(existsSync(firstRecord!.worktreePath)).toBe(false);
    expect(p.store.getRun(run.id)?.branch).toBe(firstRecord?.branch);
    const config = await readLifecycleConfig(p.root);
    await writeLifecycleConfig(p.root, { afterCreate: [{ ...script, command: 'exit 21' }], beforeRemove: [] }, config.revision);
    expect(p.manager.continueRun(run.id, { text: 'continue exactly this request' }).ok).toBe(true);
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('waiting'));
    expect(launched).toHaveLength(1);
    const regenerated = await p.manager.lifecycle.store.readWorktree(run.id);
    expect(regenerated?.worktreeId).toBe(firstRecord?.worktreeId);
    expect(regenerated?.generation).toBe(2);
    expect(existsSync(regenerated!.worktreePath)).toBe(true);
    const current = await readLifecycleConfig(p.root);
    await writeLifecycleConfig(p.root, { afterCreate: [{ ...script, command: 'printf restored > prepared' }], beforeRemove: [] }, current.revision);
    const op = await p.manager.lifecycle.store.readOperation(regenerated!.activeOperationId!);
    await p.manager.lifecycle.action(op!.id, { requestId: randomUUID(), expectedRevision: op!.revision, action: 'retry' });
    await wait(() => expect(launched).toHaveLength(2));
    expect(launched[1]?.sessionId).toBe(originalSessionId);
    expect(launched[1]?.resume).toBe(true);
    expect(launched[1]?.userPrompt).toContain('continue exactly this request');
    expect(readFileSync(join(launched[1]!.cwd, 'prepared'), 'utf8')).toBe('restored');
    await wait(() => expect(p.manager.isActive(run.id)).toBe(false));
  });

  it('reserves variant cleanup before cancelling an agent, waits for its result, and excludes retention', async () => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('true')], beforeRemove: [entry('printf cleanup > {{ root_path }}/variant-cleanup')] }, null);
    let finishAgent!: () => void;
    const interrupted = vi.fn();
    vi.mocked(ClaudeCliRunner.prototype.startSession).mockImplementation(spec => {
      launched.push(spec);
      return { result: new Promise(resolve => { finishAgent = () => resolve({text: '', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId}); }), open: true, sendMessage: () => true, end: interrupted, interrupt: interrupted };
    });
    const run = p.manager.startRun(workflow, { task: 'active losing variant', runner: 'claude' });
    await wait(() => expect(launched).toHaveLength(1));
    const record = await p.manager.lifecycle.store.readWorktree(run.id);
    p.manager.lifecycle.start();
    const discarding = p.manager.lifecycle.discardVariant(run.id);
    try {
      await wait(() => expect(interrupted).toHaveBeenCalled());
      const operations = await p.manager.lifecycle.store.listOperations(record!.worktreeId);
      expect(operations.some(operation => operation.intent === 'discard-variant' && operation.state === 'committing')).toBe(true);
      expect(existsSync(record!.worktreePath)).toBe(true);
      expect(existsSync(join(p.root, 'variant-cleanup'))).toBe(false);
      expect(await p.manager.lifecycle.reclaim(run.id)).toBe(false);
      expect((await p.manager.lifecycle.store.listOperations(record!.worktreeId)).some(operation => operation.intent === 'reclaim')).toBe(false);
    } finally { finishAgent(); await discarding.catch(() => undefined); }
    const cleanup = await discarding;
    expect(cleanup?.intent).toBe('discard-variant');
    await vi.waitFor(async () => expect((await p.manager.lifecycle.operation(cleanup!.id)).state).toBe('completed'), {timeout: 12_000, interval: 25});
    expect(readFileSync(join(p.root, 'variant-cleanup'), 'utf8')).toBe('cleanup');
    expect(existsSync(record!.worktreePath)).toBe(false);
    await expect(exec('git', ['show-ref', '--verify', `refs/heads/${record!.branch}`], {cwd: p.root})).rejects.toThrow();
    expect(p.store.getRun(run.id)?.worktreeReclaimedAt).toBeUndefined();
  });

  it.each(['resolved', 'rejected'] as const)('retains a surviving agent worktree lease after manager disposal until its result is %s', async outcome => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('true')], beforeRemove: [] }, null);
    let settleAgent!: () => void;
    const end = vi.fn();
    const interrupt = vi.fn();
    vi.mocked(ClaudeCliRunner.prototype.startSession).mockImplementation(spec => {
      launched.push(spec);
      return { result: new Promise((resolve, reject) => {
        settleAgent = () => outcome === 'resolved'
          ? resolve({text: '', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId})
          : reject(new Error('fixture provider exited'));
      }), open: true, sendMessage: () => true, end, interrupt };
    });
    const run = p.manager.startRun(workflow, { task: 'survives project context disposal', runner: 'claude' });
    await wait(() => expect(launched).toHaveLength(1));
    const worktreePath = launched[0]!.cwd;
    p.manager.dispose();
    const other = new WorktreeLifecycleCoordinator(p.root, p.store, {
      semaphore, busySlots: () => 0, isActive: () => false,
      cancelAndWait: async () => true, resume: async () => undefined,
    });
    let mutated = false;
    const mutation = other.withWorktreeMutation(run.id, async () => {
      await exec('git', ['worktree', 'remove', '--force', worktreePath], {cwd: p.root});
      mutated = true;
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(end).not.toHaveBeenCalled();
      expect(interrupt).not.toHaveBeenCalled();
      expect(mutated).toBe(false);
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      settleAgent();
      await mutation;
      other.dispose();
    }
    expect(mutated).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('releases a disposed worktree lease immediately when no provider session owns it', async () => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('true')], beforeRemove: [] }, null);
    const run = p.manager.startRun(workflow, { task: 'prepared idle worktree', runner: 'claude' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('done'));
    await wait(() => expect(p.manager.isActive(run.id)).toBe(false));
    const releaseWorktree = await p.manager.lifecycle.acquireAgentLease(run.id);
    // A prepared, idle graph/startup state owns the directory but has no provider result.
    const active = (p.manager as unknown as { active: Map<string, {releaseWorktree: () => void}> }).active;
    active.set(run.id, {releaseWorktree});
    p.manager.dispose();
    let acquired = false;
    await p.manager.lifecycle.store.withWorktreeLock(run.id, async () => { acquired = true; });
    expect(acquired).toBe(true);
  });

  it('stops an active setup variant before cleanup and never launches its agent', async () => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('printf started > setup-started; sleep 30')], beforeRemove: [entry('test -f setup-started; printf cleanup > {{ root_path }}/setup-variant-cleanup')] }, null);
    const run = p.manager.startRun(workflow, { task: 'variant discarded during setup', runner: 'claude' });
    const worktreePath = join(p.root, '.ai/cezar/worktrees', run.id);
    await wait(() => expect(existsSync(join(worktreePath, 'setup-started'))).toBe(true));
    const before = await p.manager.lifecycle.store.readWorktree(run.id);
    const setupId = before!.activeOperationId!;
    p.manager.lifecycle.start();
    const cleanup = await p.manager.lifecycle.discardVariant(run.id);
    expect(cleanup?.intent).toBe('discard-variant');
    const stopped = await p.manager.lifecycle.store.readOperation(setupId);
    expect(stopped?.state).toBe('cancelled');
    expect(stopped?.executions.at(-1)?.process?.quiescent).toBe(true);
    await vi.waitFor(async () => expect((await p.manager.lifecycle.operation(cleanup!.id)).state).toBe('completed'), {timeout: 12_000, interval: 25});
    expect(readFileSync(join(p.root, 'setup-variant-cleanup'), 'utf8')).toBe('cleanup');
    expect(existsSync(worktreePath)).toBe(false);
    expect(launched).toHaveLength(0);
  });

  it('fails visibly if a managed continuation loses its directory between preparation and agent admission', async () => {
    const p = await project();
    await writeLifecycleConfig(p.root, { afterCreate: [entry('true')], beforeRemove: [] }, null);
    const run = p.manager.startRun(workflow, {task: 'task before concurrent reclamation', runner: 'claude'});
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('done'));
    await wait(() => expect(p.manager.isActive(run.id)).toBe(false));
    const prepare = p.manager.lifecycle.prepare.bind(p.manager.lifecycle);
    vi.spyOn(p.manager.lifecycle, 'prepare').mockImplementation(async (...args) => {
      const result = await prepare(...args);
      if (result.ready) await exec('git', ['worktree', 'remove', '--force', result.path], {cwd: p.root});
      return result;
    });
    expect(p.manager.continueRun(run.id, {text: 'continue after a concurrent reclamation'}).ok).toBe(true);
    await wait(() => expect(p.store.getRun(run.id)?.status === 'failed' || launched.length > 1).toBe(true));
    expect(launched.some(spec => spec.cwd === p.root)).toBe(false);
    expect(p.store.getRun(run.id)?.status).toBe('failed');
    expect(launched).toHaveLength(1);
    expect(p.store.getRun(run.id)?.error).toMatch(/worktree|prepar/i);
    expect(launched.some(spec => spec.cwd === p.root)).toBe(false);
    await wait(() => expect(p.manager.isActive(run.id)).toBe(false));
  });

  it('keeps hook-free worktrees and explicit in-place tasks on their original paths', async () => {
    const p = await project();
    const run = p.manager.startRun(workflow, { task: 'no hooks', runner: 'claude' });
    await wait(() => expect(p.store.getRun(run.id)?.status).toBe('done'));
    expect(await p.manager.lifecycle.store.readWorktree(run.id)).toBeNull();
    expect(existsSync(launched[0]!.cwd)).toBe(true);
    await writeLifecycleConfig(p.root, { afterCreate: [entry('touch {{ root_path }}/must-not-run')], beforeRemove: [] }, null);
    const inPlace = p.manager.startRun(workflow, { task: 'read only in-place', runner: 'claude', worktree: false });
    await wait(() => expect(p.store.getRun(inPlace.id)?.status).toBe('done'));
    expect(launched[1]?.cwd).toBe(p.root);
    expect(existsSync(join(p.root, 'must-not-run'))).toBe(false);
    expect(await p.manager.lifecycle.store.readWorktree(inPlace.id)).toBeNull();
  });
});
