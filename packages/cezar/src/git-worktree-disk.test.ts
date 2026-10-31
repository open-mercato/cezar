import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ refusal: null as string | null }));
vi.mock('./disk-space.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./disk-space.ts')>()),
  diskFloorRefusal: () => disk.refusal,
}));

const { createWorktree, WORKTREES_DIR } = await import('./git-worktree.ts');
const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

describe('createWorktree on a near-full disk (9cdcedc3)', () => {
  let repo: string | undefined;
  afterEach(() => {
    disk.refusal = null;
    if (repo) rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    repo = undefined;
  });

  async function fixture(): Promise<string> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cez-wt-disk-')));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: dir });
    return dir;
  }

  it('refuses before checking anything out, with the reclaim hint', async () => {
    repo = await fixture();
    disk.refusal = 'worktree: cannot start — only 12 MB free on the disk holding <p>. Please free space';
    await expect(createWorktree(repo, 'run-full', 'main')).rejects.toThrow(/only 12 MB free/);
    expect(existsSync(join(repo, WORKTREES_DIR, 'run-full'))).toBe(false);
  });

  it('creates as before when the disk has room (or the probe cannot answer)', async () => {
    repo = await fixture();
    const info = await createWorktree(repo, 'run-ok', 'main');
    expect(existsSync(info.path)).toBe(true);
  });
});
