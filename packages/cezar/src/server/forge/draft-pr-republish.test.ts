import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftPr } from './github.ts';
import type { RunRecord } from '../../runs/store.ts';

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd, encoding: 'utf8' });

// publish → Continue (more commits, rebased) → publish again: same PR, no second one (#1758).
describe('createDraftPr re-publish (#1758)', () => {
  let dir: string;
  let remote: string;
  let bin: string;

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), 'cez-rp-remote-'));
    dir = mkdtempSync(join(tmpdir(), 'cez-rp-'));
    bin = mkdtempSync(join(tmpdir(), 'cez-rp-bin-'));
    execFileSync('git', ['init', '--bare', '-q', remote]);
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'base');
    g(dir, 'remote', 'add', 'origin', remote);
    g(dir, 'push', '-q', 'origin', 'main');
    g(dir, 'checkout', '-q', '-b', 'cez/abc');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', 'work');
    // gh: `pr create` always says the PR exists; `pr list` returns it.
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
case "$1 $2" in
  "pr create") echo 'a pull request for branch "cez/abc" already exists' >&2; exit 1;;
  "pr list") echo '[{"url":"https://github.com/o/r/pull/5","headRepositoryOwner":{"login":"o"}}]';;
  *) exit 1;;
esac
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('CEZ_DRY_RUN', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of [dir, remote, bin]) rmSync(d, { recursive: true, force: true });
  });

  it('pushes a rebased branch and reports the existing PR as updated', async () => {
    const input = {
      repoRoot: dir,
      handoffText: '# Goal\n',
      run: { worktreePath: dir, branch: 'cez/abc', baseBranch: 'main', task: 't', title: 't' } as RunRecord,
    };
    const first = await createDraftPr(input);
    expect(first).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/5', updated: true });
    g(dir, 'commit', '-q', '--amend', '-m', 'work, rebased');
    const second = await createDraftPr(input);
    expect(second).toMatchObject({ ok: true, url: 'https://github.com/o/r/pull/5', updated: true });
    expect(g(remote, 'log', '-1', '--format=%s', 'cez/abc').trim()).toBe('work, rebased');
  });
});
