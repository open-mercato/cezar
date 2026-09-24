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

const STARTED_AT = '2026-08-04T05:00:08.919Z';
const HEAD_BRANCH = 'rev-parse --abbrev-ref HEAD';
const MERGE_BASE = 'merge-base main HEAD';
const MERGE_BASE_REMOTE = 'merge-base origin/main HEAD';
const HAS_REMOTE = 'rev-parse --verify --quiet origin/main^{commit}';
const LOCAL_CURRENT = 'merge-base --is-ancestor origin/main main';
const BASELINE = `rev-parse --verify --quiet review/pr-694@{${STARTED_AT}}^{commit}`;
const NO_REMOTE = { [HAS_REMOTE]: { ok: false, stdout: '' } };

describe('resolveTaskDiffBase — the freshest base ref', () => {
  it('anchors at the merge-base when HEAD is still on the task branch', async () => {
    const { run, calls } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
    expect(calls).toContainEqual(['merge-base', 'main', 'HEAD']);
  });

  it('measures against origin/<base> when the local base ref has fallen behind', async () => {
    // The stale-local-base trap: nothing pulls the user's `main`, so the merge-base
    // collapses onto its tip and every upstream commit counts as the task's work.
    const { run } = stubGit({
      [HAS_REMOTE]: { ok: true, stdout: 'b61ae485b61ae485\n' },
      [LOCAL_CURRENT]: { ok: false, stdout: '' }, // origin/main is NOT an ancestor of main
      [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' },
      [MERGE_BASE_REMOTE]: { ok: true, stdout: 'freshfreshfresh0\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'freshfreshfresh0',
    });
  });

  it('keeps the local base ref when it is equal to or ahead of origin', async () => {
    // Unpushed base commits are real base commits — origin is not automatically newer.
    const { run, calls } = stubGit({
      [HAS_REMOTE]: { ok: true, stdout: 'b61ae485b61ae485\n' },
      [LOCAL_CURRENT]: { ok: true, stdout: '' },
      [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
    expect(calls).not.toContainEqual(['merge-base', 'origin/main', 'HEAD']);
  });

  it('leaves an already-remote base and a pinned commit sha alone', async () => {
    const { run, calls } = stubGit({ 'merge-base origin/develop HEAD': { ok: true, stdout: 'abc123abc123\n' } });

    expect(await resolveTaskDiffBase(run, 'origin/develop')).toEqual({ base: 'abc123abc123' });
    // No `origin/origin/develop` probe — the ref is already the remote's answer.
    expect(calls).toEqual([['merge-base', 'origin/develop', 'HEAD']]);
  });

  it('falls back to the base branch name when the merge-base cannot be resolved', async () => {
    const { run } = stubGit({ ...NO_REMOTE, [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' } });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'main',
    });
  });
});

describe('resolveTaskDiffBase — a repointed HEAD', () => {
  /** A review run: the checked-out branch already carried its own history. */
  const reviewRun = {
    ...NO_REMOTE,
    [HEAD_BRANCH]: { ok: true, stdout: 'review/pr-694\n' },
    [MERGE_BASE]: { ok: true, stdout: 'forkpointforkpoint\n' },
    [BASELINE]: { ok: true, stdout: 'prtipprtipprtip0\n' },
    'diff --shortstat prtipprtipprtip0': { ok: true, stdout: '' },
    'diff --shortstat forkpointforkpoint': {
      ok: true,
      stdout: ' 9 files changed, 147 insertions(+), 22 deletions(-)\n',
    },
  };

  it('anchors at the branch as this run found it, not at the branch itself', async () => {
    const { run } = stubGit(reviewRun);

    expect(
      await resolveTaskDiffBase(run, 'main', {
        taskBranch: 'cez/ab12cd34',
        runStartedAt: STARTED_AT,
      }),
    ).toEqual({
      base: 'prtipprtipprtip0',
      repointedHead: { headBranch: 'review/pr-694', taskBranch: 'cez/ab12cd34' },
    });
  });

  it('prefers the merge-base when the run merged the base branch in afterwards', async () => {
    // Then the pre-run tip is behind the upstream history the merge dragged along, and
    // anchoring there would re-attribute all of it to this task.
    const { run } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: { ok: true, stdout: 'review/pr-694\n' },
      [MERGE_BASE]: { ok: true, stdout: 'mergedbasemergedb\n' },
      [BASELINE]: { ok: true, stdout: 'oldtipoldtipoldti\n' },
      'diff --shortstat oldtipoldtipoldti': {
        ok: true,
        stdout: ' 531 files changed, 33963 insertions(+), 7358 deletions(-)\n',
      },
      'diff --shortstat mergedbasemergedb': {
        ok: true,
        stdout: ' 18 files changed, 657 insertions(+), 15 deletions(-)\n',
      },
    });

    expect(
      await resolveTaskDiffBase(run, 'main', {
        taskBranch: 'cez/ab12cd34',
        runStartedAt: STARTED_AT,
      }),
    ).toEqual({
      base: 'mergedbasemergedb',
      repointedHead: { headBranch: 'review/pr-694', taskBranch: 'cez/ab12cd34' },
    });
  });

  it('takes either anchor on a tie — a branch the agent opened at the base commit', async () => {
    // `feat/…` created from the freshest base: both anchors name the same commit, and
    // the run's own commits are the whole answer.
    const { run } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: { ok: true, stdout: 'review/pr-694\n' },
      [MERGE_BASE]: { ok: true, stdout: 'sameshasamesha00\n' },
      [BASELINE]: { ok: true, stdout: 'sameshasamesha00\n' },
      'diff --shortstat sameshasamesha00': {
        ok: true,
        stdout: ' 18 files changed, 744 insertions(+), 31 deletions(-)\n',
      },
    });

    expect(
      await resolveTaskDiffBase(run, 'main', {
        taskBranch: 'cez/ab12cd34',
        runStartedAt: STARTED_AT,
      }),
    ).toEqual({
      base: 'sameshasamesha00',
      repointedHead: { headBranch: 'review/pr-694', taskBranch: 'cez/ab12cd34' },
    });
  });

  it('narrows to HEAD when there is no run start to read the branch at (#751 behavior)', async () => {
    const { run, calls } = stubGit(reviewRun);

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'HEAD',
      repointedHead: { headBranch: 'review/pr-694', taskBranch: 'cez/ab12cd34' },
    });
    // Uncommitted work only — the answer cannot depend on the checked-out branch's history.
    expect(calls).not.toContainEqual(['merge-base', 'main', 'HEAD']);
  });

  it('narrows to HEAD when the branch reflog cannot answer', async () => {
    const { run } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: { ok: true, stdout: 'review/pr-694\n' },
      [MERGE_BASE]: { ok: true, stdout: 'forkpointforkpoint\n' },
      [BASELINE]: { ok: false, stdout: '' },
    });

    expect(
      await resolveTaskDiffBase(run, 'main', {
        taskBranch: 'cez/ab12cd34',
        runStartedAt: STARTED_AT,
      }),
    ).toEqual({
      base: 'HEAD',
      repointedHead: { headBranch: 'review/pr-694', taskBranch: 'cez/ab12cd34' },
    });
  });

  it('treats a detached HEAD as repointed, with no branch reflog to consult', async () => {
    const { run, calls } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: { ok: true, stdout: 'HEAD\n' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(
      await resolveTaskDiffBase(run, 'main', {
        taskBranch: 'cez/ab12cd34',
        runStartedAt: STARTED_AT,
      }),
    ).toEqual({
      base: 'HEAD',
      repointedHead: { headBranch: 'HEAD', taskBranch: 'cez/ab12cd34' },
    });
    expect(calls.some((args) => args.some((arg) => arg.includes('@{')))).toBe(false);
  });

  it('never builds a revision expression out of a run start that is not a timestamp', async () => {
    // `@{-1}` is "the previously checked-out branch", not a date — a stored value that is
    // not plainly ISO-8601 disables the baseline instead of being interpreted.
    const { run, calls } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: { ok: true, stdout: 'review/pr-694\n' },
    });

    expect(
      await resolveTaskDiffBase(run, 'main', {
        taskBranch: 'cez/ab12cd34',
        runStartedAt: '-1',
      }),
    ).toEqual({
      base: 'HEAD',
      repointedHead: { headBranch: 'review/pr-694', taskBranch: 'cez/ab12cd34' },
    });
    expect(calls.some((args) => args.some((arg) => arg.includes('@{')))).toBe(false);
  });
});

describe('resolveTaskDiffBase — degradation', () => {
  it('keeps the merge-base anchor when no task branch is supplied', async () => {
    const { run, calls } = stubGit({ ...NO_REMOTE, [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' } });

    expect(await resolveTaskDiffBase(run, 'main')).toEqual({ base: 'deadbeefdeadbeef' });
    // Nothing to compare HEAD against, so HEAD is never even resolved.
    expect(calls).not.toContainEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('does NOT narrow on an unreadable HEAD — a failed rev-parse is not evidence of a repoint', async () => {
    const { run } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: { ok: false, stdout: '' },
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(
      await resolveTaskDiffBase(run, 'main', {
        taskBranch: 'cez/ab12cd34',
        runStartedAt: STARTED_AT,
      }),
    ).toEqual({ base: 'deadbeefdeadbeef' });
  });

  it('ignores an empty task branch the same way an absent one is ignored', async () => {
    const { run, calls } = stubGit({ ...NO_REMOTE, [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' } });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: '' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
    expect(calls).not.toContainEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('never builds a remote probe out of an option-like base ref', async () => {
    const { run, calls } = stubGit({});

    expect(await resolveTaskDiffBase(run, '--upload-pack=evil')).toEqual({
      base: '--upload-pack=evil',
    });
    // No `origin/--upload-pack=evil` probe: the caller's `isSafeGitRef` gate rejects the
    // ref before it ever reaches git, and this helper must not smuggle it in either.
    expect(calls).toEqual([['merge-base', '--upload-pack=evil', 'HEAD']]);
  });
});
