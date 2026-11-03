import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { track } from '../telemetry.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], resumeError: '', freshError: '' }));

// A resume answers the way the real CLI does when its transcript is gone: a result error,
// then a non-zero exit carrying the stderr line. A fresh session just works.
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void) => {
      captured.specs.push(spec);
      return {
        result: new Promise<AgentRunResult>((resolve, reject) => {
          setTimeout(() => {
            if (spec.resume) {
              const exit = `claude CLI exited with code 1 — ${captured.resumeError}`;
              onEvent?.({ type: 'error', message: 'claude reported result error (error_during_execution)' });
              onEvent?.({ type: 'turn-end' });
              onEvent?.({ type: 'error', message: exit });
              reject(new Error(exit));
              return;
            }
            if (captured.freshError) {
              onEvent?.({ type: 'error', message: captured.freshError });
              reject(new Error(captured.freshError));
              return;
            }
            onEvent?.({ type: 'text', text: 'picked it up' });
            resolve({ text: 'picked it up', toolCalls: [], tokensUsed: 0 });
          }, 0);
        }),
        sendMessage: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

// Real runs with the mock CLI; the polls below already allow 15 s: well under a second alone, past the 5 s default under the full parallel suite.
describe('Continue on a Claude session whose transcript is gone', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    captured.resumeError = 'No conversation found with session ID: old-session';
    captured.freshError = '';
    vi.mocked(track).mockClear();
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-missing-session-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function terminalRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'legacy',
      task: 'make buttons use a pointer cursor',
      runner: 'claude',
      steps: [{ id: 'work', name: 'work', kind: 'agent' as const }],
    });
    store.updateRun(record.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.updateStep(record.id, 'work', { status: 'done', sessionId: 'old-session', backend: 'claude' });
    store.appendEvent(record.id, { type: 'text', stepId: 'work', text: 'Swapped cursor-default for cursor-pointer.' });
    return record.id;
  }

  /** The run starts terminal, so wait on the Continue step itself before reading the run. */
  async function settled(runId: string): Promise<string> {
    await expect
      .poll(() => store.getRun(runId)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'failed', 'cancelled'].includes(String(status)));
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
    return String(store.getRun(runId)?.status);
  }

  it('continues in a fresh session seeded with the saved context instead of failing', async () => {
    const runId = terminalRun();
    expect(manager!.continueRun(runId, { text: 'keep going', runner: 'claude' })).toEqual({ ok: true });

    expect(await settled(runId)).not.toBe('failed');
    expect(captured.specs).toHaveLength(2);
    const [resumed, fresh] = captured.specs as [AgentRunSpec, AgentRunSpec];
    expect(resumed).toMatchObject({ resume: true, sessionId: 'old-session' });
    // Resuming and the missing-session fallback must retain the same account-bound
    // usage observer; otherwise fresh Claude limits never reach deferred previews.
    expect(resumed.onUsageWindows).toEqual(expect.any(Function));
    expect(fresh.onUsageWindows).toBe(resumed.onUsageWindows);
    expect(fresh.resume).toBe(false);
    expect(fresh.sessionId).not.toBe('old-session');
    expect(fresh.userPrompt).toContain('The previous provider session cannot be resumed');
    expect(fresh.userPrompt).toContain('make buttons use a pointer cursor');
    expect(fresh.userPrompt).toContain('Swapped cursor-default for cursor-pointer.');
    expect(fresh.userPrompt).toContain('## New user instruction\nkeep going');
    // The new instruction rides once, as the instruction — not also inside the history.
    expect(fresh.userPrompt.split('keep going')).toHaveLength(2);

    const step = store.getRun(runId)?.steps.find((s) => s.id === 'continue-1');
    expect(step?.sessionId).toBe(fresh.sessionId);
    const events = store.readEvents(runId);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.some((e) => e.type === 'note' && String(e.message).includes('fresh session'))).toBe(true);
    expect(vi.mocked(track)).toHaveBeenCalledWith('session_resume_fallback', { label: 'recovered' });
    expect(vi.mocked(track)).not.toHaveBeenCalledWith('task_failed', expect.anything());
  });

  it('counts a fresh session that fails too, and the task failure it leaves behind (#1438)', async () => {
    captured.freshError = 'claude CLI exited with code 1 — boom';
    const runId = terminalRun();
    expect(manager!.continueRun(runId, { text: 'keep going', runner: 'claude' })).toEqual({ ok: true });

    expect(await settled(runId)).toBe('failed');
    expect(vi.mocked(track)).toHaveBeenCalledWith('session_resume_fallback', { label: 'fresh_failed' });
    expect(vi.mocked(track)).toHaveBeenCalledWith('task_failed', { label: 'claude:other' });
    expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toContain('old-session');
  });

  it('still fails, and shows why, when a resume fails for any other reason', async () => {
    captured.resumeError = 'Invalid API key';
    const runId = terminalRun();
    expect(manager!.continueRun(runId, { text: 'keep going', runner: 'claude' })).toEqual({ ok: true });

    expect(await settled(runId)).toBe('failed');
    expect(captured.specs).toHaveLength(1);
    const errors = store.readEvents(runId).filter((e) => e.type === 'error').map((e) => String(e.message));
    expect(errors).toEqual([
      'claude reported result error (error_during_execution)',
      'claude CLI exited with code 1 — Invalid API key',
    ]);
    expect(vi.mocked(track)).not.toHaveBeenCalledWith('session_resume_fallback', expect.anything());
  });
});
