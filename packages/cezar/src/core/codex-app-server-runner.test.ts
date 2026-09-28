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

  it('hard-stops a SIGTERM-ignoring app-server within the bounded grace', () => {
    withFakeChild((fake) => {
      const session = new CodexAppServerRunner({ bin: 'codex', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      session.hardStop?.();
      // The group SIGTERM → SIGKILL escalation lives in `terminateAgentProcessTree`.
      expect(treeHook.calls).toEqual([[fake.child, KILL_GRACE_MS]]);
    });
  });
});
