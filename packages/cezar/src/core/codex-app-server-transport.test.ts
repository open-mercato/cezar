import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EOF_KILL_GRACE_MS, EOF_TERM_GRACE_MS } from './claude-cli-runner.js';
import {
  buildCodexAppServerEnv,
  CodexAppServerRpc,
  endCodexAppServer,
  resolveCodexExecutable,
} from './codex-app-server-transport.ts';

const originalBin = process.env.CEZ_CODEX_BIN;

afterEach(() => {
  if (originalBin === undefined) delete process.env.CEZ_CODEX_BIN;
  else process.env.CEZ_CODEX_BIN = originalBin;
});

function fakeChild(): { child: ChildProcessWithoutNullStreams; writes: string[] } {
  const stdin = new PassThrough();
  const writes: string[] = [];
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => writes.push(chunk));
  return {
    child: { stdin } as unknown as ChildProcessWithoutNullStreams,
    writes,
  };
}

describe('Codex app-server transport', () => {
  it('resolves an explicit executable before the environment fallback', () => {
    process.env.CEZ_CODEX_BIN = '/host/codex';
    expect(resolveCodexExecutable('/configured/codex')).toBe('/configured/codex');
    expect(resolveCodexExecutable()).toBe('/host/codex');
  });

  it('uses the Codex child-env sanitizer and preserves per-run values', () => {
    const previousSecret = process.env.UNRELATED_TRANSPORT_SECRET;
    process.env.UNRELATED_TRANSPORT_SECRET = 'do-not-copy';
    try {
      const env = buildCodexAppServerEnv({ CEZ_TASK_ID: 'task-1' });
      expect(env.CEZ_TASK_ID).toBe('task-1');
      expect(env.UNRELATED_TRANSPORT_SECRET).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.UNRELATED_TRANSPORT_SECRET;
      else process.env.UNRELATED_TRANSPORT_SECRET = previousSecret;
    }
  });

  it('correlates out-of-order NDJSON responses and performs the shared handshake', async () => {
    const { child, writes } = fakeChild();
    const rpc = new CodexAppServerRpc(child);
    const first = rpc.request('first', {});
    const second = rpc.request('second', {});

    expect(rpc.dispatchResponse({ id: 2, result: { value: 'two' } })).toBe(true);
    expect(rpc.dispatchResponse({ id: 1, result: { value: 'one' } })).toBe(true);
    await expect(first).resolves.toEqual({ value: 'one' });
    await expect(second).resolves.toEqual({ value: 'two' });

    const initialized = rpc.initialize();
    expect(rpc.dispatchResponse({ id: 3, result: {} })).toBe(true);
    await initialized;
    expect(writes.join('')).toContain('"method":"initialize"');
    expect(writes.join('')).toContain('"method":"initialized"');
  });

  it('rejects a correlated request with the app-server error message', async () => {
    const { child } = fakeChild();
    const rpc = new CodexAppServerRpc(child);
    const request = rpc.request('model/list', {});
    rpc.dispatchResponse({ id: 1, error: { code: -32601, message: 'method unavailable' } });
    await expect(request).rejects.toThrow('method unavailable');
  });
});

/**
 * #703 — the runner can only tell its own teardown apart from a codex failure
 * if the watchdog reports every signal it sends. Without the callback firing,
 * the SIGTERM the escalation issues comes back as an unexplained 143.
 */
describe('endCodexAppServer watchdog', () => {
  function signallableChild(): {
    child: ChildProcessWithoutNullStreams;
    signals: NodeJS.Signals[];
    exit: (code: number) => void;
  } {
    const signals: NodeJS.Signals[] = [];
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      // Mirrors Node: `killed` records that a signal was *delivered*, not that
      // the child died. An app-server with its own SIGTERM handler stays alive
      // with the flag already set (#844).
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

  it('reports each escalation step so the runner can classify the exit', () => {
    vi.useFakeTimers();
    try {
      const { child, signals } = signallableChild();
      // How many signals had been sent when the callback fired — the flag must
      // be set BEFORE each kill, or the exit can race ahead of it.
      const reportedBeforeKill: number[] = [];
      endCodexAppServer(child, undefined, () => reportedBeforeKill.push(signals.length));

      // EOF alone: the server is given the full grace period first.
      expect(signals).toEqual([]);

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(signals).toEqual(['SIGTERM']);
      expect(reportedBeforeKill).toEqual([0]);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(reportedBeforeKill).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent when the app-server exits on EOF by itself', () => {
    vi.useFakeTimers();
    try {
      const { child, signals, exit } = signallableChild();
      let reported = 0;
      endCodexAppServer(child, undefined, () => {
        reported += 1;
      });
      exit(0);

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS + EOF_KILL_GRACE_MS);
      expect(signals).toEqual([]);
      expect(reported).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // #844 — the regression that gating on `child.killed` produced: the SIGTERM
  // this watchdog sends sets the flag, so the escalation vetoed itself and an
  // app-server that handles SIGTERM survived the entire teardown window.
  it('escalates to SIGKILL even though Node already flagged the child as killed', () => {
    vi.useFakeTimers();
    try {
      const { child, signals } = signallableChild();
      endCodexAppServer(child);

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(signals).toEqual(['SIGTERM']);
      // Delivery, not death: the app-server handled the signal and runs on.
      expect(child.killed).toBe(true);
      expect(child.exitCode).toBeNull();

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops escalating once the app-server really exits after SIGTERM', () => {
    vi.useFakeTimers();
    try {
      const { child, signals, exit } = signallableChild();
      endCodexAppServer(child);

      vi.advanceTimersByTime(EOF_TERM_GRACE_MS);
      expect(signals).toEqual(['SIGTERM']);
      exit(143);

      vi.advanceTimersByTime(EOF_KILL_GRACE_MS);
      expect(signals).toEqual(['SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });
});
