import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `onFail.retryOn` — which exit codes buy the agent another attempt.
 *
 * A check that exits non-zero for reasons OTHER than the diff is the case this
 * exists for: `e2e` exits 1 on a failed test, 2 on a config or credential
 * error, 3 on an engine or model-provider failure. Without the gate every one
 * of them re-ran the implement step — a full agent session, and its tokens,
 * spent on a cause that is not in the worktree, once per `max`.
 *
 * Both tests here count AGENT SESSIONS through `notes.md`: the dry-run mock
 * appends one line per session, so the line count is how many times the
 * workflow looped back. Each test gets its own repo and manager (see the
 * DISPOSE note in `run.test.ts`).
 */
describe('onFail.retryOn gates the check retry loop by exit code', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retry-on-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const workflowFor = (retryOn: number[]): WorkflowDef => ({
    name: 'implement-and-check',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      // `exit 2` stands for every "I could not run" code a richer check reports.
      {
        id: 'verify',
        name: 'Verify',
        command: 'echo CONFIG_NOT_FOUND >&2; exit 2',
        onFail: { retry: 'implement', max: 2, retryOn },
      },
    ],
  });

  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('fails the run on an unlisted exit code without re-running the agent', async () => {
    const record = manager.startRun(workflowFor([1]), {
      task: 'mock:done fix the login bug',
      worktree: false,
    });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    // The failure names the code and the gate, so the cockpit says WHY nothing retried.
    expect(finished?.error).toContain('exited 2');
    expect(finished?.error).toContain('retryOn');
    expect(finished?.steps.map((s) => ({ id: s.id, status: s.status, iterations: s.iterations }))).toEqual([
      { id: 'implement', status: 'done', iterations: 1 },
      { id: 'verify', status: 'failed', iterations: 1 },
    ]);
    // One agent session: the whole point is that exit 2 bought no second attempt.
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('still loops back on a listed exit code', async () => {
    const record = manager.startRun(workflowFor([2]), {
      task: 'mock:done fix the login bug',
      worktree: false,
    });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toContain('after 3 attempts');
    // The gate is a filter, not a switch: 2 is listed, so the loop ran its `max`.
    expect(finished?.steps.find((s) => s.id === 'implement')?.iterations).toBe(3);
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(3);
  }, 40_000);
});
