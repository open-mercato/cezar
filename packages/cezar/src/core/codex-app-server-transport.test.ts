import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodexAppServerEnv,
  CodexAppServerRpc,
  resolveCodexExecutable,
} from './codex-app-server-transport.js';

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
