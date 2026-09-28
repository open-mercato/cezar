import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import {
  KILL_GRACE_MS,
  OpencodeServerRunner,
  TURN_IDLE_GRACE_MS,
} from './opencode-server-runner.ts';

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
const treeHook = vi.hoisted(() => ({
  recording: false,
  calls: [] as Array<[unknown, number]>,
}));

vi.mock('./process-tree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-tree.ts')>();
  return {
    ...actual,
    // Only fake children are recorded; the real-server tests below keep the real teardown.
    terminateAgentProcessTree: (child: never, graceMs: number) => {
      if (!treeHook.recording) return actual.terminateAgentProcessTree(child, graceMs);
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

/**
 * #897 — an OpenCode turn that runs longer than five minutes used to park the
 * run under "Needs you".
 *
 * `opencode` holds `POST /session/:id/message` open for the whole agent turn.
 * Node's global `fetch` is undici, whose default `headersTimeout`/`bodyTimeout`
 * is 300_000 ms, so a turn still working at 5:00 lost its request with
 * `TypeError: fetch failed` — and `prompt()`'s `finally` emitted `turn-end`
 * anyway, which `workflows/run.ts` reads as "the agent stopped". The reporter
 * measured four consecutive turns on one run each dropping at exactly 5:00,
 * with SSE and tool events still flowing afterwards.
 *
 * The mock server's `#drop-post` script is that shape without the five-minute
 * wait: the message POST's socket dies mid-turn, the session keeps streaming,
 * and `session.idle` arrives later. It reproduces the CLIENT-visible symptom,
 * which is the only thing the runner can react to.
 */
describe('#897 a turn that outlives its prompt POST', () => {
  const mockBin = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'opencode', 'mock-opencode-serve.mjs');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function record(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
    const events: AgentEvent[] = [];
    return { events, onEvent: (e) => events.push(e) };
  }

  const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);
  const notes = (events: AgentEvent[]): string[] =>
    events.filter((e): e is Extract<AgentEvent, { type: 'note' }> => e.type === 'note').map((e) => e.message);
  const errors = (events: AgentEvent[]): string[] =>
    events.filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error').map((e) => e.message);
  const textIndex = (events: AgentEvent[], needle: string): number =>
    events.findIndex((e) => e.type === 'text' && e.text.includes(needle));

  /** Resolves once `count` `turn-end` events have been seen. */
  function afterTurnEnds(events: AgentEvent[], count: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (types(events).filter((t) => t === 'turn-end').length >= count) return resolve();
        if (Date.now() > deadline) return reject(new Error(`only ${types(events).filter((t) => t === 'turn-end').length} turn-end(s) after ${timeoutMs}ms`));
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  it('the first prompt (the Continue path): a dropped POST is neither a turn end nor a failure', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession(
      { userPrompt: 'watch the CI run #drop-post', cwd: process.cwd() },
      onEvent,
      { autoEndAfterFirstTurn: true },
    );
    const result = await session.result;

    // Used to be `opencode: prompt failed: fetch failed` on the later-turn path
    // and a FATAL `{type:'error'}` here, which `runContinuation` answered with
    // SIGTERM/SIGKILL on a session that was still working.
    expect(notes(events)).toEqual([]);
    expect(errors(events)).toEqual([]);

    // The turn ends on `session.idle` — after the part the server streamed
    // once the POST was already gone.
    const late = textIndex(events, 'Still working after the drop.');
    expect(late).toBeGreaterThan(-1);
    expect(types(events).indexOf('turn-end')).toBeGreaterThan(late);
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(1);
    expect(result.text).toContain('Still working after the drop.');
  }, 30_000);

  it('a later turn (the sendMessage path): the run is not parked while the session keeps working', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession({ userPrompt: 'check the tree', cwd: process.cwd() }, onEvent, {});
    await afterTurnEnds(events, 1);
    expect(notes(events)).toEqual([]);

    const firstTurnEnds = types(events).filter((t) => t === 'turn-end').length;
    expect(session.sendMessage([{ type: 'text', text: 'keep going #drop-post' }])).toBe(true);
    await afterTurnEnds(events, firstTurnEnds + 1);

    expect(notes(events)).toEqual([]);
    expect(errors(events)).toEqual([]);
    const late = textIndex(events, 'Still working after the drop.');
    expect(late).toBeGreaterThan(-1);
    // The second turn-end lands after the post-drop part, not at the drop.
    expect(types(events).lastIndexOf('turn-end')).toBeGreaterThan(late);

    session.end();
    await session.result;
  }, 30_000);

  it('a turn that finishes normally is unchanged: one turn-end, after the last part, no note', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession({ userPrompt: 'check the tree', cwd: process.cwd() }, onEvent, {
      autoEndAfterFirstTurn: true,
    });
    const result = await session.result;

    expect(notes(events)).toEqual([]);
    expect(errors(events)).toEqual([]);
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(1);
    expect(types(events)).toContain('tool-call');
    expect(types(events)).toContain('tool-result');
    // The mock answers the POST BEFORE streaming "Done." — the boundary the
    // runner used to take. Both parts are now inside the turn.
    expect(types(events).indexOf('turn-end')).toBeGreaterThan(textIndex(events, 'Done.'));
    expect(result.text).toContain('Checking the working tree.');
    expect(result.text).toContain('Done.');
  }, 30_000);

  it('the prompt POST does not go through global fetch, so undici\'s 300s default cannot reach it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession({ userPrompt: 'check the tree', cwd: process.cwd() }, onEvent, {
      autoEndAfterFirstTurn: true,
    });
    await session.result;

    expect(types(events)).toContain('turn-end');
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);

  /**
   * The transitions OUT of the state this fix introduces. `session.idle` is now
   * the boundary, so a server that never sends one — or has no event bus at all
   * — must still reach `turn-end`, or a turn becomes a state with no exit.
   */
  it('a server that never sends session.idle still ends the turn, on the grace window', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession({ userPrompt: 'check the tree #no-idle', cwd: process.cwd() }, onEvent, {
      autoEndAfterFirstTurn: true,
    });
    const started = Date.now();
    await session.result;

    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(1);
    expect(notes(events)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(TURN_IDLE_GRACE_MS);
  }, 30_000);

  it('a POST that drops on a session that then DIES is still reported', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession({ userPrompt: 'do it #drop-then-die', cwd: process.cwd() }, onEvent, {
      autoEndAfterFirstTurn: true,
    });
    await session.result;

    // Swallowing the drop must not swallow a real failure: no `session.idle`
    // ever arrived, so the drop was never explained and the note stands.
    expect(notes(events).join(' ')).toContain('opencode: prompt failed:');
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(1);
  }, 30_000);

  it('a prompt sent while a turn is still running supersedes it instead of hanging it', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession({ userPrompt: 'check the tree', cwd: process.cwd() }, onEvent, {});
    // `sendMessage` queues behind `ready`, so only once the FIRST turn is over
    // can two prompts genuinely overlap — which they do the moment the cockpit
    // delivers a second message into a task that is still running (#986).
    await afterTurnEnds(events, 1);

    expect(session.sendMessage([{ type: 'text', text: 'watch CI #drop-post' }])).toBe(true);
    expect(session.sendMessage([{ type: 'text', text: 'actually, do this instead' }])).toBe(true);
    await afterTurnEnds(events, 3);

    // Three prompts, three turn-ends. Without the supersede the second turn's
    // waiter is overwritten by the third's and never resolves — its `prompt()`
    // (and, on the first prompt, the `ready` everything else awaits) hangs.
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(3);

    session.end();
    await session.result;
  }, 30_000);

  it('with no event bus at all the HTTP response stays the turn boundary', async () => {
    const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
    const { events, onEvent } = record();
    const session = runner.startSession(
      { userPrompt: 'check the tree #no-idle', cwd: process.cwd(), env: { MOCK_NO_EVENT_BUS: '1' } },
      onEvent,
      { autoEndAfterFirstTurn: true },
    );
    const started = Date.now();
    await session.result;

    // Nothing to wait for, so no grace window is spent.
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(TURN_IDLE_GRACE_MS);
  }, 30_000);
});
