import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renameSyncWithRetry } from './fs-rename.ts';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

function flakyRename(failures: string[]) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    rename: (from: string, to: string) => {
      calls.push([from, to]);
      const code = failures.shift();
      if (code) throw errno(code);
    },
  };
}

describe('renameSyncWithRetry', () => {
  it('retries a Windows sharing violation until the holder lets go (telemetry 4a7c9f6c)', () => {
    const fake = flakyRename(['EPERM', 'EBUSY', 'EACCES']);
    const slept: number[] = [];
    renameSyncWithRetry('a.tmp', 'a', { platform: 'win32', rename: fake.rename, sleep: (ms) => slept.push(ms) });
    expect(fake.calls).toHaveLength(4);
    expect(slept).toEqual([10, 20, 40]);
  });

  it('gives up after a bounded wait and throws the original error', () => {
    const fake = flakyRename(Array(20).fill('EPERM'));
    const slept: number[] = [];
    expect(() =>
      renameSyncWithRetry('a.tmp', 'a', { platform: 'win32', rename: fake.rename, sleep: (ms) => slept.push(ms) }),
    ).toThrow(/EPERM/);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_100);
  });

  it('does not retry a non-transient error', () => {
    const fake = flakyRename(['ENOENT']);
    expect(() => renameSyncWithRetry('a.tmp', 'a', { platform: 'win32', rename: fake.rename, sleep: () => {} })).toThrow(/ENOENT/);
    expect(fake.calls).toHaveLength(1);
  });

  it('does not retry on POSIX, where EPERM is a real permission error', () => {
    const fake = flakyRename(['EPERM']);
    expect(() => renameSyncWithRetry('a.tmp', 'a', { platform: 'linux', rename: fake.rename, sleep: () => {} })).toThrow(/EPERM/);
    expect(fake.calls).toHaveLength(1);
  });

  it('renames a real file with the default fs and sleep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-rename-'));
    writeFileSync(join(dir, 'x.tmp'), 'new');
    writeFileSync(join(dir, 'x'), 'old');
    renameSyncWithRetry(join(dir, 'x.tmp'), join(dir, 'x'));
    expect(readFileSync(join(dir, 'x'), 'utf8')).toBe('new');
  });
});
