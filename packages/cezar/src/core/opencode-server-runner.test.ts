import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { KILL_GRACE_MS, OpencodeServerRunner } from './opencode-server-runner.ts';

const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

/** Records tree teardowns instead of performing them: a fake child's made-up
 *  pid would otherwise have `process.kill(-pid)` reach a real process group on
 *  the host. What the teardown then does — group SIGTERM, then a
 *  group-liveness-checked SIGKILL — is exercised against real processes in
 *  `process-tree.test.ts`. */
const treeHook = vi.hoisted(() => ({ calls: [] as Array<[unknown, number]> }));

vi.mock('./process-tree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-tree.ts')>();
  return {
    ...actual,
    terminateAgentProcessTree: (child: unknown, graceMs: number) => {
      treeHook.calls.push([child, graceMs]);
      return setTimeout(() => {}, 0);
    },
  };
});

/**
 * #858 — the OpenCode half of #844. `opencode serve` installs its own SIGTERM handler, so the
 * teardown watchdog must decide "is it dead?" from a real exit, never from `ChildProcess.killed`,
 * which Node flips the moment a signal is *delivered*. Gating on the flag made the SIGKILL
 * unreachable for exactly the server it exists for: one leaked process per teardown, and — because
 * every teardown path here is followed by `await this.exited` — a session result that never settles.
 */
describe('teardown for an opencode server that survives SIGTERM', () => {
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
      // Delivery flips `killed` whether or not the child dies, and a server that
      // handles SIGTERM runs on with the flag already true — the exact state the
      // old guard read as "already gone".
      killed: true,
      pid: 5150,
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
    vi.useFakeTimers();
    try {
      run(fake);
    } finally {
      vi.useRealTimers();
      spawnHook.override = null;
    }
  }

  /** No wall-clock deadline; the test drives the teardown itself. */
  function startSession(timeoutMs: number) {
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs }).startSession({
      userPrompt: 'do it',
      cwd: process.cwd(),
    });
    // The server never comes up behind a fake child, so the result rejects/settles on its own path.
    void session.result.catch(() => undefined);
    return session;
  }

  it('tears the tree down after end() even once Node flagged the server as killed', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      session.end();
      // Delivered, not dead — the state that used to disable the teardown.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();
      expect(treeHook.calls).toEqual([[fake.child, KILL_GRACE_MS]]);
    });
  });

  it('tears the tree down on the wall-clock timeout path', () => {
    withFakeChild((fake) => {
      startSession(20);

      vi.advanceTimersByTime(20);
      expect(treeHook.calls).toEqual([[fake.child, KILL_GRACE_MS]]);
    });
  });

  it('tears down once per session however many teardown paths run', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      // `interrupt()` on the deadline and the result promise's `finally` both
      // reach terminate() for the same session; the teardown runs once.
      session.interrupt();
      session.end();
      session.interrupt();
      expect(treeHook.calls).toEqual([[fake.child, KILL_GRACE_MS]]);
    });
  });

  it('does not touch a server that exited before the teardown', () => {
    withFakeChild((fake) => {
      const session = startSession(0);
      fake.exit(0);

      session.end();
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(treeHook.calls).toEqual([]);
      expect(fake.signals).toEqual([]);
    });
  });
});
