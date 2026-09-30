import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { KILL_GRACE_MS } from './claude-cli-runner.ts';
import { JunieRunner } from './junie-runner.ts';

/** Only the escalation tests below swap the child out; every other test in
 *  this file keeps spawning the real mock ACP process through the untouched
 *  `spawn` (mirrors `codex-app-server-runner.test.ts`'s hook). */
const spawnHook = vi.hoisted(() => ({ override: null as null | (() => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) =>
      spawnHook.override ? spawnHook.override() : actual.spawn(...args),
  };
});

const mockBin = fileURLToPath(new URL('../../scripts/mock-junie-acp.mjs', import.meta.url));

describe('JunieRunner against the mock ACP process', () => {
  it('drives the full handshake and a scripted turn end to end', async () => {
    const runner = new JunieRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'check the working tree', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    const result = await session.result;

    expect(result.text).toBe('Checking the working tree.');
    expect(result.sessionId).toBe('mock-session-1');
    // `name`/`tool` carry junie's real tool title ("git status --short"), not the ACP `kind`
    // category ("execute") — a v1 consumer would otherwise see "execute" for most calls.
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'git status --short', input: { command: 'git status --short', cwd: process.cwd() } }]);
    expect(result.tokensUsed).toBe(1500);
    expect(events).toContainEqual({ type: 'session', sessionId: 'mock-session-1' });
    expect(events).toContainEqual({ id: 'call-1', type: 'tool-call', tool: 'git status --short', input: { command: 'git status --short', cwd: process.cwd() } });
    expect(events).toContainEqual({ type: 'tool-result', toolCallId: 'call-1', result: ' M src/example.ts', isError: false });
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  }, 15_000);

  it('surfaces a failed turn (a session/prompt JSON-RPC error) as an AgentEvent error', async () => {
    const runner = new JunieRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    const session = runner.startSession(
      { userPrompt: 'mock:turn-failed', cwd: process.cwd() },
      (event) => events.push(event),
      { autoEndAfterFirstTurn: true },
    );

    await session.result;

    expect(events).toContainEqual({ type: 'error', message: 'junie: turn failed: model unavailable' });
    expect(events).toContainEqual({ type: 'turn-end' });
  }, 15_000);

  it('answers session/request_permission with allow_once even when allow_always is listed first', async () => {
    const runner = new JunieRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'mock:permission', cwd: process.cwd() },
      () => {},
      { autoEndAfterFirstTurn: true },
    );

    const result = await session.result;

    expect(result.text).toBe('permission: once');
  }, 15_000);

  it('fails loud when a bad model id is rejected by session/set_config_option (#9)', async () => {
    const runner = new JunieRunner({ bin: mockBin, timeoutMs: 0 });
    const session = runner.startSession(
      { userPrompt: 'anything', cwd: process.cwd(), model: 'mock:bad-model' },
      () => {},
    );

    await expect(session.result).rejects.toThrow(/unknown model mock:bad-model/);
  }, 15_000);

  /**
   * #703 backend parity — the same session-level shape `claude-cli-runner.test.ts`
   * and `codex-app-server-runner.test.ts` each prove for their own transport.
   * `MOCK_JUNIE_IGNORE_EOF` makes the mock stay deaf to stdin EOF and exit 143
   * on SIGTERM instead — a teardown cezar caused, never an agent failure.
   */
  it('settles the session instead of failing it when junie exits 143 after interrupt()', async () => {
    const runner = new JunieRunner({ bin: mockBin, timeoutMs: 0 });
    const events: AgentEvent[] = [];
    let sawText: () => void = () => {};
    const firstText = new Promise<void>((resolve) => {
      sawText = resolve;
    });
    const session = runner.startSession(
      { userPrompt: 'mock:hang', cwd: process.cwd(), env: { MOCK_JUNIE_IGNORE_EOF: '1' } },
      (event) => {
        events.push(event);
        if (event.type === 'text') sawText();
      },
    );
    await firstText;

    session.interrupt();
    const result = await session.result;

    expect(result.text).toBe('Working on it.');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events.some((e) => e.type === 'note' && e.message.includes('terminated by cezar (code 143)')),
    ).toBe(true);
  }, 15_000);
});

/**
 * #844 — the runner's own SIGTERM sets `ChildProcess.killed`, so a watchdog
 * gated on `!child.killed` refused to escalate for exactly the process it was
 * written for: one that handles the signal and keeps running. junie reuses
 * `trackChildExit`/`endJunieAcp` (the same helpers codex's transport uses),
 * but the WIRING — does `hardStop()` actually reach them — is per-runner.
 */
describe('SIGTERM→SIGKILL escalation for a junie process that survives SIGTERM', () => {
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

  it('hard-stops a SIGTERM-ignoring junie process within the bounded grace', () => {
    withFakeChild((fake) => {
      const session = new JunieRunner({ bin: 'junie', timeoutMs: 0 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      session.hardStop?.();
      expect(fake.signals).toEqual(['SIGTERM']);
      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('escalates on the wall-clock timeout even after Node flagged the child as killed', () => {
    withFakeChild((fake) => {
      const session = new JunieRunner({ bin: 'junie', timeoutMs: 20 }).startSession({
        userPrompt: 'do it',
        cwd: process.cwd(),
      });
      void session.result.catch(() => undefined);

      vi.advanceTimersByTime(20);
      expect(fake.signals).toEqual(['SIGTERM']);
      expect(fake.child.killed).toBe(true);
      expect(fake.child.exitCode).toBeNull();

      vi.advanceTimersByTime(KILL_GRACE_MS);
      expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  it('does not signal a second time once interrupt() saw the child exit', () => {
    withFakeChild((fake) => {
      const session = new JunieRunner({ bin: 'junie', timeoutMs: 0 }).startSession({
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
