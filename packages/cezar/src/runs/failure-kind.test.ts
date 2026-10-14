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
    ['exit code 1', 'other'],
    [undefined, 'other'],
  ] as const)('%s → %s', (message, kind) => {
    expect(failureKind(message)).toBe(kind);
  });

  it('a scheduled auto-resume marks the failure as a usage limit whatever the text says', () => {
    expect(failureKind('exit code 1', '2026-10-14T12:00:00.000Z')).toBe('usage_limit');
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

  it('does not fire for other settlements', () => {
    const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
    store.updateRun(run.id, { status: 'done' });
    store.updateRun(run.id, { status: 'cancelled' });
    expect(vi.mocked(track)).not.toHaveBeenCalledWith('task_failed', expect.anything());
  });
});
