import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  path: '',
  afterMetadata: undefined as (() => Promise<void>) | undefined,
  fail: undefined as 'stat' | 'read' | undefined,
  closes: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const result = await fs.stat(...args);
      if (args[0] === hooks.path) await hooks.afterMetadata?.();
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] !== hooks.path) return handle;
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.readFile.bind(handle);
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        if (hooks.fail === 'stat') throw new Error('metadata unavailable');
        const result = await originalStat();
        await hooks.afterMetadata?.();
        return result;
      });
      vi.spyOn(handle, 'readFile').mockImplementation(async (...readArgs) => {
        if (hooks.fail === 'read') throw new Error('read unavailable');
        return originalRead(...readArgs);
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        hooks.closes++;
        return originalClose();
      });
      return handle;
    },
  };
});

import { unresolvedConflicts } from './git-worktree.ts';

const HUNK = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n';
const CAP = 2_000_000;

describe('conflict scan file identity (CodeQL24)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cez-conflict-identity-'));
    hooks.path = join(dir, 'tracked.txt');
    hooks.afterMetadata = undefined;
    hooks.fail = undefined;
    hooks.closes = 0;
  });

  afterEach(async () => {
    hooks.afterMetadata = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function replaceAfterMetadata(original: string, replacement: string): Promise<void> {
    await writeFile(hooks.path, original);
    const next = join(dir, 'replacement.txt');
    await writeFile(next, replacement);
    hooks.afterMetadata = async () => {
      hooks.afterMetadata = undefined;
      await rename(next, hooks.path);
    };
  }

  it('does not combine a small file size with oversized replacement content', async () => {
    await replaceAfterMetadata('resolved\n', HUNK + 'x'.repeat(CAP));
    expect(await unresolvedConflicts(dir, ' M tracked.txt')).toBeNull();
    expect((await stat(hooks.path)).size).toBeGreaterThan(CAP);
    expect(hooks.closes).toBe(1);
  });

  it('keeps scanning the opened conflict after its pathname is replaced', async () => {
    await replaceAfterMetadata(HUNK, 'resolved\n');
    expect(await unresolvedConflicts(dir, ' M tracked.txt')).toBe('leftover conflict markers in tracked.txt');
    expect(await readFile(hooks.path, 'utf8')).toBe('resolved\n');
    expect(hooks.closes).toBe(1);
  });

  it('closes oversized files without scanning their conflict markers', async () => {
    await writeFile(hooks.path, HUNK + 'x'.repeat(CAP));
    expect(await unresolvedConflicts(dir, ' M tracked.txt')).toBeNull();
    expect(hooks.closes).toBe(1);
  });

  it.each(['stat', 'read'] as const)('closes after %s failure and continues scanning other files', async (failure) => {
    await writeFile(hooks.path, HUNK);
    await writeFile(join(dir, 'other.txt'), HUNK);
    hooks.fail = failure;
    expect(await unresolvedConflicts(dir, ' M tracked.txt\n M other.txt')).toBe('leftover conflict markers in other.txt');
    expect(hooks.closes).toBe(1);
  });

  it('preserves the inclusive size boundary', async () => {
    await writeFile(hooks.path, HUNK.padEnd(CAP, 'x'));
    expect(await unresolvedConflicts(dir, ' M tracked.txt')).toBe('leftover conflict markers in tracked.txt');
    expect(hooks.closes).toBe(1);
  });

  it('ignores missing files', async () => {
    expect(await unresolvedConflicts(dir, ' M tracked.txt')).toBeNull();
    expect(hooks.closes).toBe(0);
  });
});
