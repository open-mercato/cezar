import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autosaveCommit } from './git-worktree.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `autosaveCommit` must never capture a half-resolved merge (#471). The incident
 * behind that issue was an autosave committing conflict markers, and the flushes
 * that produce most autosave commits are deliberately ungated — so the guard,
 * not the `CEZ_AUTOSAVE` gate, is what actually prevents a recurrence.
 */
describe('autosave conflict guard (#471 follow-up)', () => {
  let repo: string;
  let warn: ReturnType<typeof vi.spyOn>;

  const git = (args: string[]) => run('git', args, { cwd: repo });
  const subject = async () => (await git(['log', '-1', '--format=%s'])).stdout.trim();

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-autosave-conflict-'));
    await git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'base']);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  /** Leave the repo mid-merge with a genuine conflict in `a.txt`. */
  async function startConflictingMerge(): Promise<void> {
    await git([...GIT_ID, 'checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'a.txt'), 'theirs\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'theirs']);
    await git([...GIT_ID, 'checkout', '-q', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'ours\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'ours']);
    await git([...GIT_ID, 'merge', 'other']).catch(() => undefined); // expected to conflict
  }

  it('refuses to commit an unresolved merge', async () => {
    await startConflictingMerge();
    const before = await subject();
    expect(await autosaveCommit(repo, 'turn end')).toBe('refused');
    expect(await subject()).toBe(before); // nothing new landed
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unmerged path'));
  });

  it('refuses when markers survive a premature `git add`', async () => {
    await startConflictingMerge();
    // Staging without editing clears the porcelain `U` code but leaves the
    // markers in the text — the exact shape of the original incident.
    await git(['add', 'a.txt']);
    const before = await subject();
    expect(await autosaveCommit(repo, 'run finalize')).toBe('refused');
    expect(await subject()).toBe(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leftover conflict markers'));
  });

  it('commits once the conflict is genuinely resolved', async () => {
    await startConflictingMerge();
    writeFileSync(join(repo, 'a.txt'), 'resolved\n');
    await git(['add', 'a.txt']);
    expect(await autosaveCommit(repo, 'turn end')).toBe('committed');
    expect(await subject()).toBe('cezar autosave (turn end)');
  });

  /**
   * The guard deliberately skips untracked (`??`) paths, so a test that only
   * writes a new file exercises nothing. Commit an innocuous version first,
   * then overwrite it — that is the ` M` state the scan actually looks at.
   */
  async function trackThenRewrite(name: string, content: string): Promise<void> {
    writeFileSync(join(repo, name), 'placeholder\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', `add ${name}`]);
    writeFileSync(join(repo, name), content);
  }

  const CONFLICT_HUNK = ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> other', ''].join('\n');

  it('does not mistake Markdown setext headings for conflict markers', async () => {
    // A bare `=======` line is an ordinary heading underline. Matching it would
    // refuse legitimate autosaves of this repo's own docs.
    await trackThenRewrite('doc.md', 'Title\n=======\n\nbody\n');
    expect(await autosaveCommit(repo, 'turn end')).toBe('committed');
    expect(await subject()).toBe('cezar autosave (turn end)');
  });

  it('does not trip on a file that merely documents conflict markers', async () => {
    // A checked-in patch fixture, or docs explaining how to resolve a conflict,
    // carry marker-shaped lines out of order or without the `=======` middle.
    // Requiring the full ordered triple is what keeps those autosaving.
    await trackThenRewrite(
      'doc.md',
      ['Resolving conflicts', '', '>>>>>>> is the end marker.', '<<<<<<< is the start marker.', ''].join('\n'),
    );
    expect(await autosaveCommit(repo, 'turn end')).toBe('committed');
    expect(warn).not.toHaveBeenCalled();
  });

  it('still catches a real conflict hunk written by hand', async () => {
    await trackThenRewrite('a.txt', CONFLICT_HUNK);
    expect(await autosaveCommit(repo, 'pre-PR')).toBe('refused');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leftover conflict markers'));
  });

  it('scans paths git reports quoted and octal-escaped', async () => {
    // `café.txt` reads back from porcelain as `"caf\303\251.txt"`; leaving the
    // escapes literal would make the file unopenable and hide a real conflict.
    await trackThenRewrite('café.txt', CONFLICT_HUNK);
    expect(await autosaveCommit(repo, 'turn end')).toBe('refused');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('café.txt'));
  });

  it('is a quiet no-op on a clean tree', async () => {
    expect(await autosaveCommit(repo, 'turn end')).toBe('nothing-to-do');
    expect(warn).not.toHaveBeenCalled();
  });
});
