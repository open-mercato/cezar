import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { JunieAcpRpc } from './junie-acp-transport.ts';

function fakeChild(): ChildProcessWithoutNullStreams {
  return { stdin: new PassThrough() } as unknown as ChildProcessWithoutNullStreams;
}

describe('JunieAcpRpc stdin errors', () => {
  it('swallows an async EPIPE from a child that already exited instead of leaving it unhandled', () => {
    const child = fakeChild();
    new JunieAcpRpc(child);
    expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
  });
});
