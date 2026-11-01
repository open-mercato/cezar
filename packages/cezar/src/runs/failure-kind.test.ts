import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failureKind, taskFailedLabel } from './failure-kind.ts';
import { RunStore } from './store.ts';
import { track } from '../telemetry.ts';

vi.mock('../telemetry.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), track: vi.fn() }));

describe('failureKind — task_failed closed set (#1438)', () => {
  it.each([
    ['continue failed: No conversation found with session ID: 0b6c1d2e-aaaa-bbbb-cccc-111122223333', 'missing_session'],
    ["Claude AI usage limit reached|1760450400", 'usage_limit'],
    ['Copilot CLI: please run copilot login', 'auth'],
    ['claude CLI timed out after 30m and was killed', 'timeout'],
    ['the session closed after inactivity before the task declared completion — continue to resume it', 'timeout'],
    ['session closed after 15m of inactivity', 'timeout'],
    ['Credit balance is too low', 'billing'],
    ['Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit.', 'context_too_large'],
    ['ENOSPC: no space left on device, write', 'disk_full'],
    ['API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.', 'transient'],
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth'],
    ['exit code 1', 'other'],
    [undefined, 'other'],
  ] as const)('%s → %s', (message, kind) => {
    expect(failureKind(message)).toBe(kind);
  });

  it('reads the agent error behind the prefixes run.ts adds', () => {
    expect(failureKind('continue failed: Invalid API key.')).toBe('auth');
    expect(failureKind('step "work" failed: Invalid API key.')).toBe('auth');
  });

  it('a usage limit with no reset instant is still a usage limit', () => {
    expect(failureKind("You've hit your usage limit.")).toBe('usage_limit');
  });

  it('ACP request timeouts count as timeouts', () => {
    expect(failureKind('ACP session/prompt timed out after 30s')).toBe('timeout');
  });

  it('restart bookkeeping is not counted', () => {
    expect(failureKind('interrupted — cezar process exited during the run')).toBeUndefined();
    expect(failureKind('interrupted — workflow definition not recoverable after a restart')).toBeUndefined();
  });

  it('labels as <backend>:<kind>, `unknown` without a runner', () => {
    expect(taskFailedLabel('claude', 'auth')).toBe('claude:auth');
    expect(taskFailedLabel(undefined, 'other')).toBe('unknown:other');
  });
});

describe('RunStore.updateRun → task_failed', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    vi.mocked(track).mockClear();
    dir = mkdtempSync(join(tmpdir(), 'cez-task-failed-'));
    store = RunStore.open(join(dir, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires once on the transition into failed, with a label free of ids and error text', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [], runner: 'claude' });
    store.updateRun(run.id, { status: 'running' });
    const error = 'continue failed: No conversation found with session ID: 0b6c1d2e-aaaa-bbbb-cccc-111122223333';
    store.updateRun(run.id, { status: 'failed', error });
    store.updateRun(run.id, { status: 'failed', error: 'still failed' });

    const calls = vi.mocked(track).mock.calls.filter(([event]) => event === 'task_failed');
    expect(calls).toEqual([['task_failed', { label: 'claude:missing_session' }]]);
    expect(JSON.stringify(calls)).not.toContain('0b6c1d2e');
    expect(JSON.stringify(calls)).not.toContain(run.id);
  });

  it('does not count a restart, nor an auto-resumed attempt failing again', () => {
    const restarted = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [], runner: 'claude' });
    store.updateRun(restarted.id, { status: 'running' });
    store.updateRun(restarted.id, { status: 'failed', error: 'interrupted — cezar process exited during the run' });

    const limited = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [], runner: 'claude' });
    store.updateRun(limited.id, { status: 'running' });
    store.updateRun(limited.id, { status: 'failed', error: 'Claude AI usage limit reached|1760450400' });
    store.updateRun(limited.id, { status: 'running', autoResumeAttempts: 1 });
    store.updateRun(limited.id, { status: 'failed', error: 'Claude AI usage limit reached|1760450400' });

    const calls = vi.mocked(track).mock.calls.filter(([event]) => event === 'task_failed');
    expect(calls).toEqual([['task_failed', { label: 'claude:usage_limit' }]]);
  });

  it('does not fire for other settlements', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
    store.updateRun(run.id, { status: 'done' });
    store.updateRun(run.id, { status: 'cancelled' });
    expect(vi.mocked(track)).not.toHaveBeenCalledWith('task_failed', expect.anything());
  });
});
