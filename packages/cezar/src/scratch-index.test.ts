import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinWorktreeGitDir } from './git-pin.ts';
import { seedScratchIndex, worktreeShortstat } from './git-worktree.ts';
import { collectChanges } from './server/git-changes.ts';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// scratch indexes had predictable names in the shared temp dir and were seeded
// with a plain copy, which writes through a symlink a sandboxed phase planted there (Linux).
describe.skipIf(process.platform === 'win32')('scratch git indexes', () => {
  let root: string;
  let repo: string;
  let victim: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-scratch-test-'));
    repo = join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    writeFileSync(join(repo, 'b.txt'), 'new\n');
    pinWorktreeGitDir(repo, join(repo, '.git')); // scratch indexes are a harness worktree's
    victim = join(root, 'victim');
    writeFileSync(victim, 'victim\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('seeds a scratch index without writing through a link at its path', async () => {
    const target = join(root, 'planted-index');
    symlinkSync(victim, target);
    await seedScratchIndex(repo, target);
    expect(readFileSync(victim, 'utf8')).toBe('victim\n');
  });

  it('never writes through a link planted at the old predictable names', async () => {
    const planted: string[] = [];
    for (let n = 0; n <= 200; n += 1) {
      for (const name of [`cez-wt-scratch-${process.pid}-${n}`, `cez-scratch-index-${process.pid}-${n}`]) {
        const path = join(tmpdir(), name);
        try {
          symlinkSync(victim, path);
          planted.push(path);
        } catch {
          // a name already in use by a live index is not this test's to touch
        }
      }
    }
    try {
      expect(await worktreeShortstat(repo, 'main')).not.toBeNull();
      expect(await collectChanges(repo, 'main')).toMatchObject({ ok: true });
      expect(readFileSync(victim, 'utf8')).toBe('victim\n');
    } finally {
      for (const path of planted) rmSync(path, { force: true });
    }
  });
});
