import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinWorktreeGitDir, resolveTrustedGitDir } from '../../git-pin.ts';
import type { RunRecord } from '../../runs/store.ts';
import { createDraftPr } from './github.ts';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// Create PR pushed a harness worktree without its git pin, so a pre-push hook the
// model planted under a relative core.hooksPath (husky's `.husky/_`) ran on the host.
describe('createDraftPr on a pinned harness worktree', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pr-pin-'));
    vi.stubEnv('CEZ_DRY_RUN', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs no hook the model planted in the worktree', async () => {
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    git(root, 'init', '--bare', '-q', '-b', 'main', origin);
    // The remote refuses every push, so publishing stops before gh is ever reached.
    writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'config', 'core.hooksPath', '.husky/_');
    const wt = join(repo, '.wt', 'task');
    git(repo, 'worktree', 'add', '-q', '-b', 'cez/task', wt, 'main');
    writeFileSync(join(wt, 'b.txt'), 'work\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-qm', 'work');
    const marker = join(root, 'hook-ran');
    mkdirSync(join(wt, '.husky', '_'), { recursive: true });
    writeFileSync(join(wt, '.husky', '_', 'pre-push'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(join(wt, '.husky', '_', 'pre-push'), 0o755);
    pinWorktreeGitDir(wt, resolveTrustedGitDir(repo, wt)!);

    const outcome = await createDraftPr({
      repoRoot: repo,
      handoffText: '',
      run: { worktreePath: wt, branch: 'cez/task', baseBranch: 'main', title: 't', task: 't' } as RunRecord,
    });

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('git push failed') });
    expect(existsSync(marker)).toBe(false);
  });
});
