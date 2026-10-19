import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import {
  KILL_GRACE_MS,
  OpencodeServerRunner,
  SERVER_START_MAX_MS,
  TURN_IDLE_GRACE_MS,
  opencodePermissionReply,
} from './opencode-server-runner.ts';

const spawnHook = vi.hoisted(() => ({ override: null as null | ((...args: unknown[]) => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override(...args) : actual.spawn(...args),
  };
});

/**
 * #858 — the OpenCode half of #844. `opencode serve` installs its own SIGTERM handler, so the
 * teardown watchdog must decide "is it dead?" from a real exit, never from `ChildProcess.killed`,
 * which Node flips the moment a signal is *delivered*. Gating on the flag made the SIGKILL
 * unreachable for exactly the server it exists for: one leaked process per teardown, and — because
 * every teardown path here is followed by `await this.exited` — a session result that never settles.
 */
describe('SIGTERM→SIGKILL escalation for an opencode server that survives SIGTERM', () => {
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
      killed: false,
      pid: 5150,
      // Node's semantics: delivery flips `killed` whether or not the child dies.
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal);
        Object.assign(child, { killed: true });
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

  it('escalates after end() even once Node flagged the server as killed', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      session.end();
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout path', () => {
    withFakeChild((fake) => {
      startSession(20);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the server really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      session.end();
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('sends one SIGTERM per session however many teardown paths run', () => {
    withFakeChild((fake) => {
      const session = startSession(0);

      // `interrupt()` on the deadline and the result promise's `finally` both
      // reach terminate() for the same session; the escalation is armed once.
      session.interrupt();
      session.end();
      session.interrupt();
      expect(fake.signals).toEqual(['SIGTERM']);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('does not signal at all when the server exited before the teardown', () => {
    withFakeChild((fake) => {
      const session = startSession(0);
      fake.exit(0);

      session.end();
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual([]);
    });
  });
});

describe('opencode serve startup', () => {
  function silentChild(): ChildProcessWithoutNullStreams {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      killed: false,
      pid: 5151,
      kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
  }

  afterEach(() => {
    vi.useRealTimers();
    spawnHook.override = null;
  });

  it.each([0, 0.5, 0.99999])('passes a random port in 40000–59999 and exposes the PID synchronously (random=%s)', (random) => {
    let argv: unknown;
    spawnHook.override = (_bin, args) => {
      argv = args;
      return silentChild();
    };
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(random);
    try {
      const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 0 }).startSession({ userPrompt: 'do it', cwd: process.cwd() });
      void session.result.catch(() => undefined);
      const port = 40000 + Math.floor(random * 20000);
      expect(argv).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(port)]);
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(40000);
      expect(port).toBeLessThan(60000);
      expect(session.pid).toBe(5151);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('fails the session when the server never reports a listening URL', async () => {
    spawnHook.override = () => silentChild();
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 0 }).startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => events.push(event),
    );
    void session.result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toContainEqual({ type: 'error', message: 'opencode: opencode serve did not report a listening URL within 30s' });
  });

  // 2d01c3c9: a start that keeps printing (a one-time migration) was failed at a flat 30s.
  it('keeps waiting while the server is still printing, up to the hard cap', async () => {
    const child = silentChild();
    const stderr = child.stderr as PassThrough;
    spawnHook.override = () => child;
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 0 }).startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => events.push(event),
    );
    void session.result.catch(() => undefined);
    const errorsSoFar = () => events.filter((e) => e.type === 'error');
    for (let t = 0; t < SERVER_START_MAX_MS - 20_000; t += 20_000) {
      stderr.write(`migrating ${t}\n`);
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(errorsSoFar()).toEqual([]);
    stderr.write('still migrating\n');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(errorsSoFar()).toEqual([{ type: 'error', message: `opencode: opencode serve did not report a listening URL within ${SERVER_START_MAX_MS / 1000}s` }]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'note', message: expect.stringContaining('opencode serve stderr: migrating') }));
  });

  // The message is a telemetry group key, so it never carries the elapsed time.
  it('fails with one fixed message when the server prints and then goes silent', async () => {
    const child = silentChild();
    spawnHook.override = () => child;
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const session = new OpencodeServerRunner({ bin: 'opencode', timeoutMs: 0 }).startSession(
      { userPrompt: 'do it', cwd: process.cwd() },
      (event) => events.push(event),
    );
    void session.result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(17_000);
    (child.stderr as PassThrough).write('migrating\n');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', message: 'opencode: opencode serve went silent for 30s without reporting a listening URL' },
    ]);
  });
});

describe('2d01c3c9 opencode serve that starts without the expected URL line', () => {
  const mockBin = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'opencode', 'mock-opencode-serve.mjs');
  const errors = (events: AgentEvent[]): AgentEvent[] => events.filter((e) => e.type === 'error');

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['silent', 'stderr'])('runs the turn when the URL line is %s', async (mode) => {
    const events: AgentEvent[] = [];
    const session = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 }).startSession(
      { userPrompt: 'check the tree', cwd: process.cwd(), env: { MOCK_START: mode } },
      (e) => events.push(e),
      { autoEndAfterFirstTurn: true },
    );
    const result = await session.result;
    expect(errors(events)).toEqual([]);
    expect(events.map((e) => e.type)).toContain('turn-end');
    expect(result.sessionId).toBe('ses_mock_1');
  }, 30_000);

  it('never adopts a server on that port that serves another directory', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const events: AgentEvent[] = [];
    const session = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 0 }).startSession(
      { userPrompt: 'check the tree', cwd: process.cwd(), env: { MOCK_START: 'silent', MOCK_PATH_DIR: tmpdir() } },
      (e) => events.push(e),
    );
    // Real time for the real probes (setInterval is not faked) to reach it.
    await new Promise<void>((r) => setImmediate(r));
    const until = performance.now() + 2_000;
    while (performance.now() < until) await new Promise<void>((r) => setImmediate(r));
    expect(events.find((e) => e.type === 'session')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await session.result.catch(() => undefined);
    expect(errors(events)).toEqual([{ type: 'error', message: 'opencode: opencode serve did not report a listening URL within 30s' }]);
  }, 30_000);
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

describe('permission prompts outside the worktree (c3d30076 hung 21 h on one)', () => {
  const mockBin = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'opencode', 'mock-opencode-serve.mjs');
  const runs = '/repo/.ai/cezar/runs';
  const env = { CEZ_HANDOFF_FILE: `${runs}/r1.handoff.md`, CEZ_TASK_ID: 'r1' };
  const ask = (filepath: string, permission = 'external_directory') => ({
    id: 'per_1',
    permission,
    patterns: [`${dirname(filepath)}/*`],
    metadata: { filepath },
  });

  it('grants exactly this run\'s handoff file and its own pasted attachments', () => {
    expect(opencodePermissionReply(ask(`${runs}/r1.handoff.md`), env)).toBe('once');
    expect(opencodePermissionReply(ask(`${runs}/r1-images/pasted-1.png`), env)).toBe('once');
  });

  it('refuses everything else outside the worktree', () => {
    expect(opencodePermissionReply(ask(`${runs}/r2.handoff.md`), env)).toBe('reject');
    expect(opencodePermissionReply(ask(`${runs}/r1.ndjson`), env)).toBe('reject');
    expect(opencodePermissionReply(ask(`${runs}/r2-images/pasted-1.png`), env)).toBe('reject');
    expect(opencodePermissionReply(ask(`${runs}/r1-images/../r2.handoff.md`), env)).toBe('reject');
    expect(opencodePermissionReply(ask(`${runs}/r1-images/nested/x.png`), env)).toBe('reject');
    expect(opencodePermissionReply(ask('/etc/passwd'), env)).toBe('reject');
    expect(opencodePermissionReply(ask(`${runs}/r1.handoff.md`, 'bash'), env)).toBe('reject');
  });

  it('grants anything under the run\'s own TMPDIR, and only when cezar set it there', () => {
    const tmp = '/repo/.ai/cezar/tmp/r1';
    const withTmp = { ...env, TMPDIR: tmp };
    expect(opencodePermissionReply(ask(`${tmp}/build/out.log`), withTmp)).toBe('once');
    expect(opencodePermissionReply(ask(`${tmp}/build/out.log`), env)).toBe('reject');
    expect(opencodePermissionReply(ask('/repo/.ai/cezar/tmp/r2/x'), withTmp)).toBe('reject');
    expect(opencodePermissionReply(ask('/repo/.ai/cezar/tmp/r1-other/x'), withTmp)).toBe('reject');
    expect(opencodePermissionReply(ask('/tmp/x'), { ...env, TMPDIR: '/tmp' })).toBe('reject');
  });

  it('compares paths after following symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-oc-perm-'));
    try {
      mkdirSync(join(root, 'data', 'runs', 'r1-images'), { recursive: true });
      symlinkSync(join(root, 'data'), join(root, 'link'));
      symlinkSync('/etc', join(root, 'data', 'runs', 'r1-images', 'escape'));
      const viaLink = { CEZ_HANDOFF_FILE: join(root, 'link', 'runs', 'r1.handoff.md'), CEZ_TASK_ID: 'r1' };
      // OpenCode reports the real path; cezar handed out the symlinked one.
      expect(opencodePermissionReply(ask(join(root, 'data', 'runs', 'r1.handoff.md')), viaLink)).toBe('once');
      expect(opencodePermissionReply(ask(join(root, 'data', 'runs', 'r1-images', 'a.png')), viaLink)).toBe('once');
      expect(opencodePermissionReply(ask(join(root, 'link', 'runs', 'r1-images', 'escape', 'hosts')), viaLink)).toBe('reject');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the run has no handoff file to compare against', () => {
    expect(opencodePermissionReply(ask(`${runs}/r1.handoff.md`), undefined)).toBe('reject');
    expect(opencodePermissionReply({ id: 'per_1', permission: 'external_directory' }, env)).toBe('reject');
  });

  for (const [label, path, reply, legacy] of [
    ['the handoff file is approved', `${runs}/r1.handoff.md`, 'once', false],
    ['another path is refused', `${runs}/r2.handoff.md`, 'reject', false],
    ['a pre-rework server is answered on its session route', `${runs}/r1.handoff.md`, 'once', true],
  ] as const) {
    it(`a turn blocked on a prompt finishes: ${label}`, async () => {
      const runEnv = legacy ? { ...env, MOCK_LEGACY_PERMISSION: '1' } : env;
      const runner = new OpencodeServerRunner({ bin: mockBin, timeoutMs: 60_000 });
      const events: AgentEvent[] = [];
      const session = runner.startSession(
        { userPrompt: `read it #permission ${path}`, cwd: process.cwd(), env: runEnv },
        (e) => events.push(e),
        { autoEndAfterFirstTurn: true },
      );
      const result = await session.result;
      expect(result.text).toContain(`permission ${reply}`);
      const notes = events.filter((e) => e.type === 'note').map((e) => (e as { message: string }).message);
      expect(notes).toEqual(reply === 'reject' ? [`opencode: refused external_directory permission for ${path}`] : []);
    }, 30_000);
  }
});
