import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  afterResolve: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
  handles: [] as FileHandle[],
}));

// Real files and handles, with deterministic replacement at filesystem boundaries.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const result = await fs.realpath(...args);
      const replace = boundary.afterResolve;
      boundary.afterResolve = undefined;
      replace?.();
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      boundary.handles.push(handle);
      const replace = boundary.afterOpen;
      boundary.afterOpen = undefined;
      replace?.();
      return handle;
    },
  };
});

import { readWorktreePath } from './git-changes.ts';

describe('readWorktreePath — checked file identity (CodeQL 29)', () => {
  let dir: string;
  let root: string;
  let target: string;
  let outside: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-file-race-'));
    root = join(dir, 'worktree');
    mkdirSync(root);
    mkdirSync(join(root, 'sub'));
    target = join(root, 'sub', 'file.txt');
    outside = join(dir, 'file.txt');
    writeFileSync(target, 'safe\n');
    writeFileSync(outside, 'SECRET\n');
  });

  afterEach(async () => {
    boundary.afterResolve = undefined;
    boundary.afterOpen = undefined;
    // Assert closure, but clean up even when a regression leaves a descriptor open.
    const handles = boundary.handles.splice(0);
    try {
      for (const handle of handles) expect(handle.fd).toBe(-1);
    } finally {
      await Promise.all(handles.map((handle) => handle.close()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a leaf replaced by an outside symlink after realpath', async () => {
    boundary.afterResolve = () => {
      renameSync(target, `${target}.old`);
      symlinkSync(outside, target);
    };
    expect((await readWorktreePath(root, 'sub/file.txt')).kind).toBe('invalid');
  });

  it.skipIf(process.platform === 'win32')('rejects an ancestor replaced by an outside symlink after realpath', async () => {
    boundary.afterResolve = () => {
      renameSync(join(root, 'sub'), join(root, 'old-sub'));
      symlinkSync(dir, join(root, 'sub'));
    };
    expect((await readWorktreePath(root, 'sub/file.txt')).kind).toBe('invalid');
  });

  it('rejects a different regular file installed after validation', async () => {
    boundary.afterResolve = () => {
      renameSync(target, `${target}.old`);
      writeFileSync(target, 'replacement\n');
    };
    expect((await readWorktreePath(root, 'sub/file.txt')).kind).toBe('invalid');
  });

  it.skipIf(process.platform === 'win32')('rejects a replacement FIFO without waiting for a writer', async () => {
    boundary.afterResolve = () => {
      renameSync(target, `${target}.old`);
      execFileSync('mkfifo', [target], { timeout: 5_000 });
    };
    expect((await readWorktreePath(root, 'sub/file.txt')).kind).toBe('invalid');
  });

  it('keeps sniffing and content on the original descriptor after pathname replacement', async () => {
    boundary.afterOpen = () => {
      renameSync(target, `${target}.old`);
      writeFileSync(target, 'SECRET\n');
    };
    expect(await readWorktreePath(root, 'sub/file.txt')).toEqual({
      kind: 'file', path: 'sub/file.txt', size: 5, binary: false, tooLarge: false, content: 'safe\n',
    });
    expect(boundary.handles).toHaveLength(1);
  });

  it('uses descriptor metadata if the checked file grows before opening', async () => {
    boundary.afterResolve = () => writeFileSync(target, 'larger than cap\n');
    const result = await readWorktreePath(root, 'sub/file.txt', 5);
    expect(result).toEqual({ kind: 'file', path: 'sub/file.txt', size: 16, binary: false, tooLarge: true });
  });

  it('closes the descriptor for binary content', async () => {
    writeFileSync(target, Buffer.from([0, 1, 2]));
    expect(await readWorktreePath(root, 'sub/file.txt')).toEqual({
      kind: 'file', path: 'sub/file.txt', size: 3, binary: true, tooLarge: false,
    });
  });

  it('closes the descriptor when metadata inspection fails', async () => {
    boundary.afterOpen = () => {
      const handle = boundary.handles.at(-1);
      if (!handle) throw new Error('expected an open handle');
      vi.spyOn(handle, 'stat').mockRejectedValueOnce(new Error('stat failed'));
    };
    await expect(readWorktreePath(root, 'sub/file.txt')).rejects.toThrow('stat failed');
  });

  it('closes the descriptor when the content read fails', async () => {
    boundary.afterOpen = () => {
      const handle = boundary.handles.at(-1);
      if (!handle) throw new Error('expected an open handle');
      vi.spyOn(handle, 'readFile').mockRejectedValueOnce(new Error('read failed'));
    };
    await expect(readWorktreePath(root, 'sub/file.txt')).rejects.toThrow('read failed');
  });

  it('preserves empty text responses', async () => {
    writeFileSync(target, '');
    expect(await readWorktreePath(root, 'sub/file.txt')).toEqual({
      kind: 'file', path: 'sub/file.txt', size: 0, binary: false, tooLarge: false, content: '',
    });
  });
});
