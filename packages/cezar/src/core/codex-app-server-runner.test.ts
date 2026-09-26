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
 * #955 — a `contextCompaction` item is internal session maintenance, not the user being
 * handed the next action. The runner is the only layer that can tell the two apart, because
 * `turn/completed` looks identical either way by the time it reaches `RunManager`. These pin
 * the seam: the boundary rides out on the v1 `turn-end` as an ADDITIVE optional `reason`,
 * never as a new event type and never in place of the existing `contextCompaction` tool item.
 *
 * No redacted Luna trace was obtainable, so the fixture is built from the documented wire
 * contract — see the header of `mock-codex-app-server.mjs`.
 */
describe('a turn that ended at a context-compaction boundary (#955)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  /** Run one scripted prompt to completion and collect the v1 stream. */
  async function collect(userPrompt: string): Promise<AgentEvent[]> {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession({ userPrompt, cwd: process.cwd() }, (event) => events.push(event), {
      autoEndAfterFirstTurn: true,
    });
    await session.result;
    return events;
  }

  it('marks the turn-end as context-compaction and still emits the tool item', async () => {
    const events = await collect('mock:compaction-hold refactor the parser');
    // ADDITIVE, not a replacement: the "Compacted context" row still renders from the
    // unchanged tool-call/tool-result pair, so nothing that reads v1 today loses a frame.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call', tool: 'contextCompaction' }),
    );
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([
      { type: 'turn-end', reason: 'context-compaction' },
    ]);
  }, 15_000);

  it('leaves an ordinary turn-end bare, so old consumers see no new field', async () => {
    const events = await collect('check the working tree');
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
  }, 15_000);

  it('does not claim a compaction boundary when the model spoke after it', async () => {
    // `mock:compaction-done` compacts AFTER a `CEZ:DONE` message. The compaction is still
    // the last ITEM, which is exactly why the runner reports the boundary and `run.ts` —
    // not the runner — owns marker precedence. The text must survive intact either way.
    const events = await collect('mock:compaction-done wrap it up');
    expect(events.some((e) => e.type === 'text' && e.text.includes('CEZ:DONE'))).toBe(true);
  }, 15_000);

  it('never lets a CHILD thread compaction end the parent turn (#600 holds)', async () => {
    const events = await collect('mock:child-compaction fan out');
    // The child's own turn lifecycle is dropped, and its compaction item must not colour
    // the parent's boundary — the parent ended on its own message, so no reason at all.
    expect(events.filter((e) => e.type === 'turn-end')).toEqual([{ type: 'turn-end' }]);
    expect(events.some((e) => e.type === 'text' && e.text.includes('after the sub-agent compacted'))).toBe(true);
  }, 15_000);
});

/**
 * #955, second half — `sendMessage()` answers `true` the moment the frame is written to
 * stdin, long before the app-server's JSON-RPC response settles. `RunManager.deliverMessage`
 * takes that `true` as delivery, clears `waiting` and writes `running`; a later rejection
 * used to surface only as a quiet `note`, so the run sat there looking alive forever. The
 * rejection now speaks with the SAME authority `turn/failed` already has: an `error` event.
 */
describe('an asynchronous turn/start or turn/steer rejection (#955)', () => {
  const mockBin = fileURLToPath(
    new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url),
  );

  it('surfaces a refused follow-up turn/start as an error, not a quiet note', async () => {
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawTurnEnd: () => void = () => {};
    const firstTurnEnd = new Promise<void>((resolve) => {
      sawTurnEnd = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'mock:compaction-reject refactor the parser', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'turn-end') sawTurnEnd();
      },
    );
    await firstTurnEnd;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    await expect
      .poll(() => events.some((e) => e.type === 'error'), { timeout: 10_000 })
      .toBe(true);
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', message: expect.stringContaining('busy compacting context') });
    session.end();
    await session.result.catch(() => undefined);
  }, 20_000);

  it('reports a refused turn/steer WITHOUT killing the turn still in flight', async () => {
    // The other half of the rule, and the reason it is not "escalate every rejection": a
    // refused steer leaves no zombie — the turn is genuinely running and `running` is
    // genuinely true. Escalating would interrupt it and throw away real work to report a
    // problem the run does not have. What was lost is the follow-up, and the note says so.
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      // The turn stays OPEN, so the follow-up steers it instead of starting a new turn.
      { userPrompt: 'mock:steer-reject keep going', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    await expect
      .poll(() => events.some((e) => e.type === 'note' && e.message.includes('did not reach the model')), {
        timeout: 10_000,
      })
      .toBe(true);
    expect(events.find((e) => e.type === 'note' && e.message.includes('did not reach the model'))).toMatchObject({
      message: expect.stringContaining('expectedTurnId'),
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(session.open).toBe(true); // the live turn was NOT torn down
    session.end();
    await session.result.catch(() => undefined);
  }, 20_000);

  it("keeps cezar's OWN teardown a note, so cancelling never fails the run (#703 parity)", async () => {
    // The in-flight request the escalation must NOT fire on: `mock:steer-silent` never
    // answers the steer, so it is still pending when `interrupt()` tears the session down
    // and `rejectPending` settles it. Escalating that to `error` would turn every cancel
    // into a failed run — the exact class of self-inflicted failure #703 removed.
    const runner = new CodexAppServerRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'mock:steer-silent keep going', cwd: process.cwd() },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    expect(session.sendMessage([{ type: 'text', text: 'Continue' }])).toBe(true);
    session.interrupt();
    await session.result.catch(() => undefined);

    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 20_000);
});

/**
 * #844 — the runner's own SIGTERM sets `ChildProcess.killed`, so a watchdog
 * gated on `!child.killed` refused to escalate for exactly the app-server it
 * was written for: one that handles the signal and keeps running. The guard now
 * tracks real termination, and `terminatedByCezar` (#703) is still set before
 * every signal so the resulting 137/143 stays a teardown note, not a failure.
 */
describe('SIGTERM→SIGKILL escalation for an app-server that survives SIGTERM', () => {
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
      pid: 4243,
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

  it('escalates on the wall-clock timeout even after Node flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      // Delivered, not dead — the state that used to disable the escalation.
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('stops escalating once the app-server really exits after SIGTERM', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      fake.exit(143);

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM']);
    });
  });

  it('does not signal a second time once interrupt() saw the child exit', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);
      fake.exit(0);

      session.interrupt();
      expect(fake.signals).toEqual([]);
    });
  });
});
