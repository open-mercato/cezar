import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileWithRetry, renameSyncWithRetry, renameWithRetry } from './fs-rename.ts';

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

describe('readFileWithRetry', () => {
  const flakyRead = (failures: string[]) => ({
    calls: 0,
    async readFile(this: { calls: number }) {
      this.calls += 1;
      const code = failures.shift();
      if (code) throw errno(code);
      return 'content';
    },
  });

  it('retries a Windows sharing violation on read, so the caller never sees a busy file as absent', async () => {
    const flaky = flakyRead(['EBUSY', 'EPERM']);
    const text = await readFileWithRetry('x', { platform: 'win32', readFile: flaky.readFile.bind(flaky), sleep: async () => {} });
    expect(text).toBe('content');
    expect(flaky.calls).toBe(3);
  });

  it('does not retry ENOENT, nor anything on POSIX', async () => {
    const missing = flakyRead(['ENOENT']);
    await expect(readFileWithRetry('x', { platform: 'win32', readFile: missing.readFile.bind(missing), sleep: async () => {} })).rejects.toMatchObject({ code: 'ENOENT' });
    const posix = flakyRead(['EBUSY']);
    await expect(readFileWithRetry('x', { platform: 'linux', readFile: posix.readFile.bind(posix) })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(missing.calls + posix.calls).toBe(2);
  });
});

describe('renameWithRetry', () => {
  function flakyAsync(failures: string[]) {
    const sync = flakyRename(failures);
    return { calls: sync.calls, rename: async (from: string, to: string) => sync.rename(from, to) };
  }

  it('retries a Windows sharing violation without blocking the event loop', async () => {
    const fake = flakyAsync(['EPERM', 'EBUSY']);
    const slept: number[] = [];
    await renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: fake.rename, sleep: async (ms) => slept.push(ms) });
    expect(fake.calls).toHaveLength(3);
    expect(slept).toEqual([10, 20]);
  });

  it('gives up after the same bounded wait and rejects with the original error', async () => {
    const fake = flakyAsync(Array(20).fill('EACCES'));
    const slept: number[] = [];
    await expect(
      renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: fake.rename, sleep: async (ms) => slept.push(ms) }),
    ).rejects.toThrow(/EACCES/);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_100);
  });

  it('does not retry on POSIX or for a non-transient error', async () => {
    const posix = flakyAsync(['EPERM']);
    await expect(renameWithRetry('a.tmp', 'a', { platform: 'linux', rename: posix.rename })).rejects.toThrow(/EPERM/);
    expect(posix.calls).toHaveLength(1);
    const missing = flakyAsync(['ENOENT']);
    await expect(renameWithRetry('a.tmp', 'a', { platform: 'win32', rename: missing.rename })).rejects.toThrow(/ENOENT/);
    expect(missing.calls).toHaveLength(1);
  });

  it('renames a real file with the default fs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-rename-'));
    writeFileSync(join(dir, 'x.tmp'), 'new');
    writeFileSync(join(dir, 'x'), 'old');
    await renameWithRetry(join(dir, 'x.tmp'), join(dir, 'x'));
    expect(readFileSync(join(dir, 'x'), 'utf8')).toBe('new');
  });
});
