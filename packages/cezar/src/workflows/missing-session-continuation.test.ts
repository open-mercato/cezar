import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, AgentSession } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { MISSING_SESSION_NOTE } from './resume-fallback.ts';
import { RunManager } from './run.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

type Failure = 'claude' | 'codex' | 'opencode' | 'auth' | 'opencode-model' | 'cancel';

const runner = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], failure: 'claude' as Failure }));

// Each backend says "that session is gone" its own way (#1193): Claude as an error event plus a
// failing exit, Codex by rejecting `thread/resume` with no event at all, OpenCode as an error event
// on a session result that still resolves. A fresh session just works.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    interrupt: async () => {},
    startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): AgentSession {
      runner.specs.push(spec);
      let interrupted: () => void = () => undefined;
      const result = new Promise<AgentRunResult>((resolve, reject) => {
        const done = { text: '', toolCalls: [], tokensUsed: 0 };
        setTimeout(() => {
          if (!spec.resume) {
            onEvent?.({ type: 'text', text: 'picked it up' });
            resolve({ ...done, text: 'picked it up' });
            return;
          }
          const fail = (message: string, event = true) => {
            if (event) onEvent?.({ type: 'error', message });
            reject(new Error(message));
          };
          switch (runner.failure) {
            case 'claude': return fail('claude CLI exited with code 1 — No conversation found with session ID: old-session');
            case 'codex': return fail('no rollout found for thread id old-session', false);
            case 'opencode':
              onEvent?.({ type: 'error', message: 'opencode: opencode no longer has the session this task resumes' });
              return resolve(done);
            case 'opencode-model':
              onEvent?.({ type: 'error', message: 'opencode: POST /session/old-session/message → 500 model not found' });
              return resolve(done);
            case 'auth': return fail('authentication failed: session token missing from configuration');
            case 'cancel':
              interrupted = () => reject(new Error('No conversation found with session ID: old-session'));
          }
        }, 0);
      });
      return {
        result,
        open: true,
        sendMessage: () => false,
        end: () => undefined,
        interrupt: () => interrupted(),
      };
    },
  }),
}));

describe('Continue on a Codex or OpenCode session that is gone (#1193)', { timeout: 20_000 }, () => {
  const saved = { dry: process.env.CEZ_DRY_RUN, lock: process.env.CEZ_DISABLE_REPO_LOCK };
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    // The repo-root lock stays ON: a fallback that re-entered the Continue would wait on its own lease.
    delete process.env.CEZ_DISABLE_REPO_LOCK;
    runner.specs = [];
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-missing-session-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (saved.dry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved.dry;
    if (saved.lock === undefined) delete process.env.CEZ_DISABLE_REPO_LOCK;
    else process.env.CEZ_DISABLE_REPO_LOCK = saved.lock;
  });

  function seed(backend: 'claude' | 'codex' | 'opencode'): string {
    const record = store.createRun({
      title: 'recover', workflow: 'quick-task', task: 'recover the task', runner: backend,
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 'task', { status: 'done', sessionId: 'old-session', backend });
    store.appendEvent(record.id, { type: 'text', stepId: 'task', text: 'PRIOR-HISTORY-MARKER' });
    return record.id;
  }

  const events = (runId: string) => readFileSync(join(repoRoot, '.ai/cezar/runs', `${runId}.ndjson`), 'utf8');
  const repoRootBusy = () => (manager as unknown as { repoRootBusy: number }).repoRootBusy;

  it.each([
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['opencode', 'opencode'],
  ] as const)('%s: falls back once to a fresh session with the same launch, and frees the tree', async (failure, backend) => {
    runner.failure = failure;
    const runId = seed(backend);
    expect(manager.continueRun(runId, { text: 'fresh follow-up' })).toEqual({ ok: true });
    await expect.poll(() => store.getRun(runId)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 }).toBe('done');

    expect(runner.specs.map((spec) => spec.resume)).toEqual([true, false]);
    const [resumed, fresh] = runner.specs;
    expect(fresh?.userPrompt).toContain('PRIOR-HISTORY-MARKER');
    expect(fresh?.userPrompt).toContain('fresh follow-up');
    // One launch closure: the fresh session keeps the resumed one's policy, account and model.
    expect(fresh?.allowedTools).toEqual(resumed?.allowedTools);
    expect(fresh?.bashAllowlist).toEqual(resumed?.bashAllowlist);
    expect(fresh?.env).toEqual(resumed?.env);
    expect(fresh?.model).toEqual(resumed?.model);
    const log = events(runId);
    expect(log).toContain(MISSING_SESSION_NOTE);
    expect((log.match(/"type":"user-message"/g) ?? []).length).toBe(1);
    expect(store.getRun(runId)?.error).toBeUndefined();
    await expect.poll(() => manager.isActive(runId)).toBe(false);
    expect(repoRootBusy()).toBe(0);
  });

  it.each([
    ['auth', 'claude'],
    ['auth', 'codex'],
    ['opencode-model', 'opencode'],
  ] as const)('%s on %s: a failure that only mentions a session is not retried', async (failure, backend) => {
    runner.failure = failure;
    const runId = seed(backend);
    expect(manager.continueRun(runId, { text: 'try it' })).toEqual({ ok: true });
    await expect.poll(() => store.getRun(runId)?.status, { timeout: 15_000 }).toBe('failed');
    expect(runner.specs).toHaveLength(1);
    expect(events(runId)).not.toContain(MISSING_SESSION_NOTE);
  });

  it('a cancelled Continue never falls back', async () => {
    runner.failure = 'cancel';
    const runId = seed('claude');
    expect(manager.continueRun(runId, { text: 'cancel me' })).toEqual({ ok: true });
    await expect.poll(() => runner.specs.length, { timeout: 15_000 }).toBe(1);
    expect(manager.cancel(runId)).toBe(true);
    await expect.poll(() => store.getRun(runId)?.status, { timeout: 15_000 }).toBe('cancelled');
    expect(runner.specs).toHaveLength(1);
  });
});
