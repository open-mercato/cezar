import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

let root: string, store: RunStore, manager: RunManager;
const workflow = { name: 'quick-task', source: 'built-in' as const, steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AUTO_NAMING', '0');
  root = mkdtempSync(join(tmpdir(), 'cez-landing-lifecycle-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  store = RunStore.open(join(root, '.ai/cezar'));
  manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
});
afterEach(() => {
  for (const run of store.listRuns()) manager.cancel(run.id);
  manager.dispose();
  store.flush();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function record() {
  const run = store.createRun({ title: 'Review me', task: 'Task', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] });
  store.updateStep(run.id, 'task', { status: 'done', sessionId: 'mock-session' });
  store.updateRun(run.id, { status: 'review', workflowDef: workflow, worktree: false, baseBranch: git('rev-parse', 'HEAD') });
  return run;
}
function config(checks: string[] = []) {
  writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ landing: 'auto', requiredChecks: checks }));
}
// Observe the promise launched by the PUBLIC Finish API; never substitute the landing.
function finish(runId: string): Promise<void> {
  const spy = vi.spyOn(manager as unknown as { finishReview(id: string): Promise<void> }, 'finishReview');
  expect(manager.finish(runId)).toBe(true);
  return spy.mock.results.at(-1)!.value as Promise<void>;
}

it.each(['manual', 'clean', 'dirty'])('Finish records accepted atomically (%s)', async mode => {
  if (mode !== 'manual') config();
  const run = record();
  if (mode === 'dirty') writeFileSync(join(root, 'a.txt'), 'changed\n');
  const reasons: unknown[] = [];
  store.setLifecycleObserver((_before, after) => {
    if (after?.status === 'done') reasons.push(after.completionReason);
  });
  await finish(run.id);
  expect(run.status).toBe('done');
  expect(run.completionReason).toBe('accepted');
  expect(reasons).toEqual(['accepted']);
});

it.each(['review', 'done', 'cancelled'] as const)('explicit Commit from %s preserves done or records acceptance', async status => {
  config();
  const run = record();
  store.updateRun(run.id, { status, completionReason: status === 'done' ? 'completed' : undefined });
  writeFileSync(join(root, 'a.txt'), 'changed\n');
  const reasons: unknown[] = [];
  store.setLifecycleObserver((before, after) => {
    if (before?.status !== 'done' && after?.status === 'done') reasons.push(after.completionReason);
  });
  expect((await manager.land(run.id)).outcome).toBe('landed');
  expect(reasons).toEqual(status === 'done' ? [] : ['accepted']);
  expect(run.status).toBe('done');
  expect(run.completionReason).toBe(status === 'done' ? 'completed' : 'accepted');
});

for (const action of ['commit', 'finish'] as const) {
  for (const defer of [false, true]) {
    it.each([0, 1])(`${action} cannot settle or reopen a cancelled ${defer ? 'deferred' : 'direct'} continuation (check exit=%s)`, async exitCode => {
      const entered = join(root, '.ai/cezar/entered');
      const release = join(root, '.ai/cezar/release');
      const script = join(root, '.ai/cezar/gate.cjs');
      writeFileSync(script, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(entered)},'');let n=0;const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(${exitCode})}if(++n>500){clearInterval(t);process.exit(1)}},20);`);
      config([`node ${script}`]);
      const run = record();
      writeFileSync(join(root, 'a.txt'), 'changed\n');
      const statuses: string[] = [];
      store.setLifecycleObserver((before, after) => {
        if (after && before?.status !== after.status) statuses.push(after.status);
      });
      const work = action === 'commit' ? manager.land(run.id) : finish(run.id);
      try {
        await vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 5000 });
        expect(manager.continueRun(run.id, { text: 'followup' }, defer).ok).toBe(true);
        expect(manager.cancel(run.id)).toBe(true);
        expect(run.status).toBe('cancelled');
        const continueSpy = vi.spyOn(manager, 'continueRun');
        writeFileSync(release, '');
        await work;
        expect(run.status).toBe('cancelled');
        expect(statuses).toEqual(defer ? ['queued', 'cancelled'] : ['cancelled']);
        expect(continueSpy).not.toHaveBeenCalled();
        expect(run.landing).toBeUndefined();
      } finally {
        writeFileSync(release, '');
        await work;
      }
    }, 15000);
  }
}

it('no-policy Finish cannot accept a newer review generation after its await', async () => {
  const run = record();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const policy = vi.spyOn(manager as unknown as { landingPolicy(...args: unknown[]): Promise<undefined> }, 'landingPolicy');
  policy.mockImplementation(async () => { await gate; return undefined; });
  const work = finish(run.id);
  try {
    await vi.waitFor(() => expect(policy).toHaveBeenCalled());
    expect(manager.continueRun(run.id, { text: 'followup' }, true).ok).toBe(true);
    expect(manager.cancel(run.id)).toBe(true);
    // A newer generation can itself return to review before the old await resolves.
    store.updateRun(run.id, { status: 'review' });
    release();
    await work;
    expect(run.status).toBe('review');
    expect(run.completionReason).toBeUndefined();
  } finally {
    release();
    await work;
  }
});

it('Finish keeps review open when a required check fails', async () => {
  config(['exit 1']);
  const run = record();
  writeFileSync(join(root, 'a.txt'), 'changed\n');
  await finish(run.id);
  expect(run.status).toBe('review');
  expect(run.completionReason).toBeUndefined();
  expect(run.landing?.status).toBe('failed');
});

it('Commit still offers a failed check to the current session for repair', async () => {
  config(['exit 1']);
  const run = record();
  writeFileSync(join(root, 'a.txt'), 'changed\n');
  const continuation = vi.spyOn(manager, 'continueRun');
  expect((await manager.land(run.id)).outcome).toBe('failed');
  expect(continuation).toHaveBeenCalledOnce();
  expect(run.steps.at(-1)?.id).toBe('continue-1');
});
