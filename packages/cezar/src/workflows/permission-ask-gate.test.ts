import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentRunSpec, SessionOptions } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every SessionOptions a (mocked) runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ opts: [] as Array<SessionOptions | undefined> }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (_spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts?: SessionOptions) => {
      captured.opts.push(opts);
      const sessionId = `sess-${captured.opts.length}`;
      return {
        result: new Promise<AgentRunResult>((resolve) => {
          setTimeout(() => {
            onEvent?.({ type: 'session', sessionId });
            resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
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

/**
 * #2042: a backend permission prompt may park a run only when a human can answer it. A native
 * ask parks mid-turn with no nudge and no idle timer, so an autonomous run or a headless
 * `cezar run` (no `CEZ_API_URL`) would never leave that park. `ActiveRun` has two construction
 * sites (`execute`, `runContinuation`) and both must hand the runner the same gate.
 */
describe('permission prompts park only an attended run (#2042)', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedApiUrl = process.env.CEZ_API_URL;
  const DEF: WorkflowDef = { name: 'one', source: 'file', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] };

  beforeEach(async () => {
    captured.opts.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-permission-gate-'));
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
    if (savedApiUrl === undefined) delete process.env.CEZ_API_URL;
    else process.env.CEZ_API_URL = savedApiUrl;
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function optsAt(index: number): Promise<SessionOptions> {
    await expect.poll(() => captured.opts.length, { timeout: 15_000 }).toBeGreaterThan(index);
    return captured.opts[index] as SessionOptions;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  it('asks in an attended cockpit run, on the opening session and on Continue', async () => {
    process.env.CEZ_API_URL = 'http://127.0.0.1:1';
    const record = manager!.startRun(DEF, { task: 't', worktree: false, runner: 'claude' });
    const opening = await optsAt(0);
    await settled(record.id);
    expect(manager!.continueRun(record.id, { text: 'more', runner: 'claude' })).toEqual({ ok: true });
    const resumed = await optsAt(1);
    expect(opening.canAskPermission?.()).toBe(true);
    expect(resumed.canAskPermission?.()).toBe(true);
    await expect
      .poll(() => store.getRun(record.id)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'failed', 'cancelled'].includes(String(status)));
    await settled(record.id);
  });

  it('never asks in an autonomous run', async () => {
    process.env.CEZ_API_URL = 'http://127.0.0.1:1';
    const record = manager!.startRun(DEF, { task: 't', worktree: false, runner: 'claude', autonomous: true });
    expect((await optsAt(0)).canAskPermission?.()).toBe(false);
    await settled(record.id);
  });

  it('never asks in a headless `cezar run` (no cockpit address)', async () => {
    delete process.env.CEZ_API_URL;
    const record = manager!.startRun(DEF, { task: 't', worktree: false, runner: 'claude' });
    expect((await optsAt(0)).canAskPermission?.()).toBe(false);
    await settled(record.id);
  });
});
