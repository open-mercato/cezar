import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHeadCommit, getRepoInfo } from './git.ts';

/**
 * getRepoInfo remote discovery: the forge seam (and so the GitHub tab) hangs
 * off `repo.remote`, so it must be found for HTTPS and SSH URLs alike, and for
 * repos whose only remote is NOT named `origin` (a plain `git remote get-url
 * origin` fails there). Genuinely remote-less repos still report no remote.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

describe('getRepoInfo — remote discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-git-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an HTTPS origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reads an SSH (scp-like) origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('falls back to the first configured remote when none is named origin', async () => {
    g(dir, 'remote', 'add', 'github', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('prefers origin when several remotes exist', async () => {
    g(dir, 'remote', 'add', 'upstream', 'https://github.com/upstream/demo.git');
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reports no remote for a genuinely remote-less repo', async () => {
    const info = await getRepoInfo(dir);
    expect(info).not.toBeNull();
    expect(info?.remote).toBeUndefined();
  });

  it('pins the current commit as a full SHA', async () => {
    expect(await getHeadCommit(dir)).toBe(g(dir, 'rev-parse', 'HEAD').trim());
  });

  it('returns null outside a git repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cez-nogit-'));
    try {
      expect(await getRepoInfo(bare)).toBeNull();
      expect(await getHeadCommit(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
