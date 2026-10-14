import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, AgentRunSpec, AgentSession, AgentEvent } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager, toPastedContent } from './run.ts';

const runnerState = vi.hoisted(() => ({
  calls: [] as AgentRunSpec[], backend: '' as string, failure: 'missing' as 'missing' | 'auth' | 'cancel',
  pendingReject: undefined as ((error: Error) => void) | undefined,
}));
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    startSession(spec: AgentRunSpec, _onEvent?: (event: AgentEvent) => void): AgentSession {
      runnerState.calls.push(spec);
      const missing = spec.resume === true && (runnerState.failure === 'missing' || runnerState.failure === 'cancel');
      return {
        result: runnerState.failure === 'cancel' && spec.resume === true
          ? new Promise((_, reject) => { runnerState.pendingReject = reject; })
          : missing
          ? Promise.reject(new Error(
              runnerState.backend === 'opencode'
                ? 'GET /session/old-session → 404 not found'
                : runnerState.backend === 'codex'
                  ? 'no rollout found for thread old-session'
                  : 'No conversation found with session ID old-session',
            ))
          : spec.resume === true
            ? Promise.reject(new Error('authentication failed: session token missing from configuration'))
            : Promise.resolve({ text: 'fresh session completed', toolCalls: [], tokensUsed: 0, sessionId: 'fresh-session' }),
        open: true,
        sendMessage: () => false,
        end: () => undefined,
        interrupt: () => {
          runnerState.pendingReject?.(new Error('No conversation found with session ID old-session'));
          runnerState.pendingReject = undefined;
        },
      };
    },
  }),
}));

describe('missing-session Continue fallback lifecycle', () => {
  const oldEnv = { CEZ_DRY_RUN: process.env.CEZ_DRY_RUN, CEZ_DISABLE_REPO_LOCK: process.env.CEZ_DISABLE_REPO_LOCK };
  const backends = ['claude', 'codex', 'opencode'] as const;

  afterEach(() => {
    if (oldEnv.CEZ_DRY_RUN === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = oldEnv.CEZ_DRY_RUN;
    if (oldEnv.CEZ_DISABLE_REPO_LOCK === undefined) delete process.env.CEZ_DISABLE_REPO_LOCK;
    else process.env.CEZ_DISABLE_REPO_LOCK = oldEnv.CEZ_DISABLE_REPO_LOCK;
  });

  async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for continuation');
  }

  it('public Continue forwards a fresh attachment and prior context exactly once after fallback', async () => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
    runnerState.backend = 'claude';
    runnerState.failure = 'missing';
    runnerState.calls = [];
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-public-continue-'));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const manager = new RunManager(store, repoRoot);
    try {
      const record = store.createRun({
        title: 'public recovery', workflow: 'quick-task', task: 'recover with context', runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
      store.updateStep(record.id, 'task', { status: 'done', sessionId: 'old-session', backend: 'claude' });
      store.appendEvent(record.id, { type: 'text', stepId: 'task', text: 'PRIOR-HISTORY-MARKER' });
      const result = manager.continueRun(record.id, {
        text: 'fresh follow-up',
        images: [toPastedContent({ mediaType: 'text/plain', data: Buffer.from('fresh attachment').toString('base64'), name: 'fresh.txt' })],
      });
      expect(result).toEqual({ ok: true });
      await waitFor(() => store.getRun(record.id)?.steps.some((step) => step.id === 'continue-1' && step.status === 'done') === true);

      expect(runnerState.calls).toHaveLength(2);
      expect(runnerState.calls[0]?.resume).toBe(true);
      expect(runnerState.calls[1]?.resume).toBe(false);
      expect(runnerState.calls[1]?.userPrompt).toContain('PRIOR-HISTORY-MARKER');
      expect(runnerState.calls[1]?.userPrompt).toContain('fresh follow-up');
      expect(runnerState.calls[1]?.userPrompt).toContain('pasted-1.txt');
      const events = readFileSync(join(repoRoot, '.ai/cezar', 'runs', `${record.id}.ndjson`), 'utf8');
      expect((events.match(/"type":"user-message"/g) ?? []).length).toBe(1);
      expect((events.match(/fresh follow-up/g) ?? []).length).toBe(1);
      expect((events.match(/pasted-1.txt/g) ?? []).length).toBe(1);
      expect(manager.isActive(record.id)).toBe(false);
    } finally {
      manager.dispose();
      store.flush();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(backends)('retries %s once with portable context and settles the run', async (backend) => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
    runnerState.backend = backend;
    runnerState.failure = 'missing';
    runnerState.calls = [];
    const repoRoot = mkdtempSync(join(tmpdir(), `cez-missing-${backend}-`));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const manager = new RunManager(store, repoRoot);
    try {
      const record = store.createRun({
        title: 'recover',
        workflow: 'quick-task',
        task: 'recover the task',
        runner: backend,
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
      store.updateStep(record.id, 'task', { status: 'done', sessionId: 'old-session', backend });
      const attachmentPath = join(repoRoot, 'notes.txt');
      writeFileSync(attachmentPath, 'attachment');
      store.addStep(record.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });

      const internals = manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> };
      await internals.runContinuation(
        record.id,
        'continue-1',
        'old-session',
        backend,
        'recover the task',
        [],
        [],
        [{ name: 'notes.txt', url: '/api/v1/runs/notes.txt', path: attachmentPath }],
        undefined,
        undefined,
        ['PENDING-REPORT-ONCE', 'INBOX-ONCE'],
      );

      expect(runnerState.calls).toHaveLength(2);
      expect(runnerState.calls[0]?.resume).toBe(true);
      expect(runnerState.calls[1]?.resume).toBe(false);
      expect(runnerState.calls[1]?.userPrompt).toContain('recover the task');
      expect(runnerState.calls[1]?.userPrompt).toContain(attachmentPath);
      expect((runnerState.calls[1]?.userPrompt.match(/PENDING-REPORT-ONCE/g) ?? []).length).toBe(1);
      expect((runnerState.calls[1]?.userPrompt.match(/INBOX-ONCE/g) ?? []).length).toBe(1);
      expect(store.getRun(record.id)?.status).toBe('done');
      expect(store.getRun(record.id)?.steps.find((step) => step.id === 'continue-1')?.status).toBe('done');
      expect(manager.isActive(record.id)).toBe(false);
    } finally {
      manager.dispose();
      store.flush();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not retry a nonmissing authentication failure', async () => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
    runnerState.backend = 'claude';
    runnerState.failure = 'auth';
    runnerState.calls = [];
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-auth-failure-'));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const manager = new RunManager(store, repoRoot);
    try {
      const record = store.createRun({
        title: 'auth failure', workflow: 'quick-task', task: 'auth failure', runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
      store.updateStep(record.id, 'task', { status: 'done', sessionId: 'old-session', backend: 'claude' });
      store.addStep(record.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
      const internals = manager as unknown as { runContinuation: (...args: unknown[]) => Promise<void> };
      await internals.runContinuation(record.id, 'continue-1', 'old-session', 'claude', 'try auth');
      expect(runnerState.calls).toHaveLength(1);
      expect(store.getRun(record.id)?.status).toBe('failed');
      expect(manager.isActive(record.id)).toBe(false);
    } finally {
      manager.dispose();
      store.flush();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not fallback after cancellation of a missing-session Continue', async () => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
    runnerState.backend = 'claude';
    runnerState.failure = 'cancel';
    runnerState.calls = [];
    runnerState.pendingReject = undefined;
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-cancel-continue-'));
    const store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const manager = new RunManager(store, repoRoot);
    try {
      const record = store.createRun({
        title: 'cancel recovery', workflow: 'quick-task', task: 'cancel recovery', runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
      store.updateStep(record.id, 'task', { status: 'done', sessionId: 'old-session', backend: 'claude' });
      expect(manager.continueRun(record.id, { text: 'cancel me' })).toEqual({ ok: true });
      await waitFor(() => runnerState.calls.length === 1);
      expect(manager.cancel(record.id)).toBe(true);
      await waitFor(() => store.getRun(record.id)?.status === 'cancelled');
      expect(runnerState.calls).toHaveLength(1);
    } finally {
      manager.dispose();
      store.flush();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
