import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraftPr } from './github.js';
import type { RunRecord } from '../../runs/store.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The pre-PR autosave is the LAST flush — unlike the turn-end and run-finalize
 * ones, no later autosave picks the work up. So when the conflict guard (#471)
 * refuses it, publishing must stop with a human-readable error rather than
 * pushing a branch that is missing the run's final state.
 */
describe('createDraftPr pre-PR autosave (#471 follow-up)', () => {
  let repo: string;
  let warn: ReturnType<typeof vi.spyOn>;

  const git = (args: string[]) => run('git', args, { cwd: repo });

  const input = () => ({
    repoRoot: repo,
    handoffText: '# Goal\n\nship it\n',
    run: { worktreePath: repo, branch: 'cez/abc123', task: 'do the thing' } as RunRecord,
  });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-draft-pr-'));
    await git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'base']);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('CEZ_DRY_RUN', '1'); // stop before push/gh; the guard runs earlier
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
  });

  it('refuses to publish a worktree holding conflict markers', async () => {
    writeFileSync(
      join(repo, 'a.txt'),
      ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> other', ''].join('\n'),
    );
    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('unresolved merge conflicts');
  });

  it('refuses to publish an unresolved merge', async () => {
    await git([...GIT_ID, 'checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'a.txt'), 'theirs\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'theirs']);
    await git([...GIT_ID, 'checkout', '-q', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'ours\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'ours']);
    await git([...GIT_ID, 'merge', 'other']).catch(() => undefined); // expected to conflict

    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('unresolved merge conflicts');
  });

  it('publishes normally when the worktree is clean', async () => {
    writeFileSync(join(repo, 'a.txt'), 'finished work\n');
    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(true);
    // The final state landed on the branch before publishing.
    const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: repo });
    expect(stdout.trim()).toBe('cezar autosave (pre-PR)');
  });

  it('publishes when there was nothing left to flush', async () => {
    const outcome = await createDraftPr(input());
    expect(outcome.ok).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
