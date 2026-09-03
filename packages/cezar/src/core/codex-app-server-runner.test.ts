import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.js';
import { KILL_GRACE_MS } from './claude-cli-runner.js';
import { CodexAppServerRunner } from './codex-app-server-runner.js';

/** Only the escalation tests below swap the child out; every other test in this
 *  file keeps spawning the real mock app-server through the untouched `spawn`. */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/** Records tree teardowns instead of performing them while a fake child is
 *  installed: its made-up pid would otherwise have `process.kill(-pid)` reach a
 *  real process group on the host. The real-process tests in this file keep the
 *  real teardown, and what it does — group SIGTERM, then a
 *  group-liveness-checked SIGKILL — is covered by `process-tree.test.ts`. */
const treeHook = vi.hoisted(() => ({
  recording: false,
  calls: [] as Array<[unknown, number]>,
}));

vi.mock('./process-tree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-tree.ts')>();
  return {
    ...actual,
    terminateAgentProcessTree: (child: never, graceMs: number) => {
      if (!treeHook.recording) return actual.terminateAgentProcessTree(child, graceMs);
      treeHook.calls.push([child, graceMs]);
      return setTimeout(() => {}, 0);
    },
  };
});

/**
 * #703 backend parity — `claude-cli-runner.test.ts` proves the Claude half;
 * this is the same session-level shape for Codex. The fix only holds if BOTH
 * runners classify a cezar-initiated 128+signal exit as a teardown note rather
 * than an agent failure, so the Codex branch needs its own regression.
 */
describe('a teardown cezar initiated (codex app-server)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('settles the session instead of failing it when the app-server exits 143', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // MOCK_CODEX_IGNORE_EOF makes the mock stay deaf to stdin EOF and exit
      // 143 on SIGTERM — the real shape reported in #703.
      { userPrompt: 'check the working tree', cwd: process.cwd(), env: { MOCK_CODEX_IGNORE_EOF: '1' } },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    // The cancel path; the EOF watchdog reaches the same `terminatedByCezar`.
    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('Checking the working tree.');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);

  it('forces the restricted sandbox for stage-only harness phases', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      {
        userPrompt: 'review without publishing',
        cwd: process.cwd(),
        env: { CEZ_HARNESS_STAGE_ONLY: '1' },
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 15_000);

  it('grants additional directories as writable roots under the stage-only sandbox', async () => {
    // The phase-result contract writes OUTSIDE the worktree (the run's
    // agent-output dir). Claude gets it via --add-dir; codex must get it as
    // sandbox_workspace_write.writable_roots or the implementer finishes the
    // work and then EPERMs on the one file the driver requires (run d6ebd27c).
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      {
        userPrompt: 'implement the phase',
        cwd: process.cwd(),
        env: {
          CEZ_HARNESS_STAGE_ONLY: '1',
          MOCK_CODEX_REQUIRE_WRITABLE_ROOTS: '/data/runs/x-harness/agent-output',
        },
        additionalDirectories: ['/data/runs/x-harness/agent-output'],
      },
      undefined,
      { autoEndAfterFirstTurn: true },
    );
    await expect(session.result).resolves.toMatchObject({ sessionId: 'th_mock_1' });
  }, 15_000);

  it('surfaces a failed turn as an AgentEvent error', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:turn-failed', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events).toContainEqual({ type: 'error', message: 'model unavailable' });
    expect(events).toContainEqual({ type: 'turn-end' });
  }, 15_000);
});

/**
 * #844 — the runner's own SIGTERM sets `ChildProcess.killed`, so a watchdog
 * gated on `!child.killed` refused to tear down for exactly the app-server it
 * was written for: one that handles the signal and keeps running. The guard now
 * tracks real termination, and `terminatedByCezar` (#703) is still set before
 * every teardown so the resulting 137/143 stays a teardown note, not a failure.
 *
 * The teardown itself is `terminateAgentProcessTree`, asserted here as a call
 * rather than as signals — see the module mock above.
 */
describe('teardown for an app-server that survives SIGTERM', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      // Delivery flips `killed` whether or not the child dies; an app-server
      // that handles SIGTERM runs on with the flag already true.
      killed: true,
      pid: 4243,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    const exit = (code: number) => {
      Object.assign(child, { exitCode: code });
      emitter.emit('exit', code, null);
    };
    return { child, signals, exit };
  }

  function withFakeChild(run: (fake: ReturnType<typeof signallableChild>) => void): void {
    const fake = signallableChild();
    spawnHook.override = () => fake.child;
    treeHook.calls.length = 0;
    treeHook.recording = true;
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      treeHook.recording = false;
      spawnHook.override = null;
    }
  }

  it('tears the tree down on the wall-clock timeout even after Node flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      // Delivered, not dead — the state that used to disable the teardown.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();
      expect(treeHook.calls).toEqual([[fake.child, KILL_GRACE_MS]]);
    });
  });

  it('does not touch an app-server that interrupt() saw exit', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      fake.exit(0);

      session.interrupt();
      expect(treeHook.calls).toEqual([]);
      expect(fake.signals).toEqual([]);
    });
  });
});
