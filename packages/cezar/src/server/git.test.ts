import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as gitApi from './git.ts';
import { getBranches, getHeadCommit, getRepoInfo } from './git.ts';

/** Named via the namespace so the memo tests can load against a build that
 *  predates the export and still fail on behavior, not on an import error. */
const clearRepoInfoCache = (gitApi as { clearRepoInfoCache?: () => void }).clearRepoInfoCache;

/**
 * A PATH shim that logs every `git` invocation and execs the real binary, so a
 * test can assert on the number of child processes a helper starts. Each test
 * installs and restores its own (vitest gives each file its own worker).
 */
function installGitShim(): { calls: () => number; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-git-shim-'));
  const log = join(dir, 'calls.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(join(dir, 'git'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ''}`;
  const count = () => {
    try {
      return readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return {
    calls: count,
    restore: () => {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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


it('preserves the default non-isolated path for repositories before their first commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-unborn-'));
  try {
    g(dir, 'init', '-q', '-b', 'main');
    // RunManager uses this null result to select serial in-place execution.
    expect(await getRepoInfo(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getRepoInfo memoization', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-git-memo-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
    return dir;
  }

  it('serves a repeated default read from the memo; a clear makes it fresh again', async () => {
    const dir = repo();
    const shim = installGitShim();
    try {
      clearRepoInfoCache?.();
      const start = shim.calls();
      await getRepoInfo(dir);
      const first = shim.calls();
      expect(first).toBeGreaterThan(start);
      await getRepoInfo(dir);
      expect(shim.calls()).toBe(first);
      clearRepoInfoCache?.();
      await getRepoInfo(dir);
      expect(shim.calls()).toBeGreaterThan(first);
    } finally {
      shim.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves identity-sensitive option-bearing reads uncached', async () => {
    const dir = repo();
    const shim = installGitShim();
    try {
      clearRepoInfoCache?.();
      await getRepoInfo(dir, { requireRemoteRead: true });
      const first = shim.calls();
      await getRepoInfo(dir, { requireRemoteRead: true });
      expect(shim.calls()).toBeGreaterThan(first);
    } finally {
      shim.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bypasses the memo for a fresh read of a branch switched inside the TTL', async () => {
    const dir = repo();
    try {
      clearRepoInfoCache?.();
      expect((await getRepoInfo(dir))?.branch).toBe('main');
      g(dir, 'checkout', '-q', '-b', 'other');
      // The cached default is still the branch it saw a moment ago…
      expect((await getRepoInfo(dir))?.branch).toBe('main');
      // …while a fresh read reflects the checkout that already happened.
      expect((await getRepoInfo(dir, { fresh: true }))?.branch).toBe('other');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getBranches', () => {
  it('answers local and remote branches in a single git spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-git-branches-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
    g(dir, 'branch', 'feature');
    g(dir, 'branch', 'cez/deadbeef');
    const shim = installGitShim();
    try {
      const start = shim.calls();
      const branches = await getBranches(dir);
      expect(shim.calls() - start).toBe(1);
      expect(branches).toContain('main');
      expect(branches).toContain('feature');
      expect(branches).not.toContain('cez/deadbeef');
    } finally {
      shim.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
