import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBaseRef } from './git-worktree.ts';

/**
 * A `git` shim that makes `merge-base --is-ancestor` fail with exit 128 (a
 * broken object / transient failure), while every other call reaches the real
 * binary. Only a clean exit 1 may be read as "origin is ahead".
 */
function installFailingAncestorShim(): { restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-git-shim-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\ncase " $* " in\n`
      + `  *" merge-base --is-ancestor "*) exit 128 ;;\n`
      + `esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(join(dir, 'git'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ''}`;
  return {
    restore: () => {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('resolveBaseRef — broken ancestry probe', () => {
  it('keeps the local base when `merge-base --is-ancestor` fails for a non-ancestor reason', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cez-b10-'));
    const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
    // A local ref named `origin/main`, so both sides of the probe resolve.
    g('branch', 'origin/main');

    const shim = installFailingAncestorShim();
    try {
      expect(await resolveBaseRef(repo, 'main')).toBe('main');
    } finally {
      shim.restore();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
