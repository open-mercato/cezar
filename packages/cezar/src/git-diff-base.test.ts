import { describe, expect, it } from 'vitest';
import { resolveTaskDiffBase, type GitRunner } from './git-diff-base.ts';

/**
 * The one place the "which ref anchors this task's diff" rule lives (#751).
 * Driven with a stub runner rather than a real repo: what is under test is the
 * DECISION (which git commands run, and which base comes back), not git's own
 * behavior — the real-git coverage sits on the two callers
 * (`git-worktree.test.ts`, `server/git-changes.test.ts`).
 */
function stubGit(answers: Record<string, { ok: boolean; stdout: string }>): {
  run: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push(args);
    return answers[args.join(' ')] ?? { ok: false, stdout: '' };
  };
  return { run, calls };
}

const MERGE_BASE = 'merge-base main HEAD';
const HEAD_BRANCH = 'rev-parse --abbrev-ref HEAD';

describe('resolveTaskDiffBase', () => {
  it('anchors at the merge-base when HEAD is still on the task branch', async () => {
    const { run, calls } = stubGit({
      [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
    expect(calls).toEqual([['rev-parse', '--abbrev-ref', 'HEAD'], ['merge-base', 'main', 'HEAD']]);
  });

  it('anchors at HEAD and reports the repoint when HEAD is on another branch', async () => {
    const { run, calls } = stubGit({
      [HEAD_BRANCH]: { ok: true, stdout: 'review/pr-694\n' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'HEAD',
      repointedHead: { headBranch: 'review/pr-694', taskBranch: 'cez/ab12cd34' },
    });
    // The merge-base is not even asked for — the answer cannot depend on it.
    expect(calls).toEqual([['rev-parse', '--abbrev-ref', 'HEAD']]);
  });

  it('treats a detached HEAD as repointed — it is not the task branch either', async () => {
    const { run } = stubGit({
      [HEAD_BRANCH]: { ok: true, stdout: 'HEAD\n' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'HEAD',
      repointedHead: { headBranch: 'HEAD', taskBranch: 'cez/ab12cd34' },
    });
  });

  it('keeps the pre-#751 merge-base anchor when no task branch is supplied', async () => {
    const { run, calls } = stubGit({ [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' } });

    expect(await resolveTaskDiffBase(run, 'main')).toEqual({ base: 'deadbeefdeadbeef' });
    // Nothing to compare HEAD against, so HEAD is never even resolved.
    expect(calls).toEqual([['merge-base', 'main', 'HEAD']]);
  });

  it('falls back to the base branch name when the merge-base cannot be resolved', async () => {
    const { run } = stubGit({ [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' } });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'main',
    });
  });

  it('does NOT narrow on an unreadable HEAD — a failed rev-parse is not evidence of a repoint', async () => {
    const { run } = stubGit({
      [HEAD_BRANCH]: { ok: false, stdout: '' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
  });

  it('ignores an empty task branch the same way an absent one is ignored', async () => {
    const { run, calls } = stubGit({ [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' } });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: '' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
    expect(calls).toEqual([['merge-base', 'main', 'HEAD']]);
  });
});
