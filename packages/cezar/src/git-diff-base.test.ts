import { describe, expect, it } from 'vitest';
import * as diffBase from './git-diff-base.ts';
import { resolveTaskDiffBase, type GitRunner } from './git-diff-base.ts';

/** Namespace-resolved so these tests load against a build that predates the
 *  export and fail on behavior, not on an import error. */
const clearTaskDiffBaseCache = (diffBase as { clearTaskDiffBaseCache?: () => void }).clearTaskDiffBaseCache;

/**
 * The one place the "which ref anchors this task's diff" rule lives (#751).
 * Driven with a stub runner rather than a real repo: what is under test is the
 * DECISION (which git commands run, and which base comes back), not git's own
 * behavior — the real-git coverage sits on the two callers
 * (`git-worktree.test.ts`, `server/git-changes.test.ts`).
 */
function stubGit(answers: Record<string, { ok: boolean; stdout: string; code?: number }>): {
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
// The sha and the branch are read in one spawn; the sha keys the memo.
const HEAD_BRANCH = 'rev-parse HEAD --abbrev-ref HEAD';
const HEAD_SHA = 'headshaheadshahead0';
const headRef = (branch: string) => ({ ok: true, stdout: `${HEAD_SHA}\n${branch}\n` });
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
      [HEAD_BRANCH]: headRef('cez/ab12cd34'),
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
      [LOCAL_CURRENT]: { ok: false, stdout: '', code: 1 }, // origin/main is NOT an ancestor of main
      [HEAD_BRANCH]: headRef('cez/ab12cd34'),
      [MERGE_BASE_REMOTE]: { ok: true, stdout: 'freshfreshfresh0\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'freshfreshfresh0',
    });
  });

  it('keeps the local base when `merge-base --is-ancestor` fails for a reason other than "not ancestor"', async () => {
    // A transient/broken git (exit 128, a signal, an ENOENT) says nothing about
    // ancestry. Only a clean exit 1 picks origin; anything else must not silently
    // switch the diff base.
    const { run } = stubGit({
      [HAS_REMOTE]: { ok: true, stdout: 'b61ae485b61ae485\n' },
      [LOCAL_CURRENT]: { ok: false, stdout: '', code: 128 },
      [HEAD_BRANCH]: headRef('cez/ab12cd34'),
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
  });

  it('keeps the local base ref when it is equal to or ahead of origin', async () => {
    // Unpushed base commits are real base commits — origin is not automatically newer.
    const { run, calls } = stubGit({
      [HAS_REMOTE]: { ok: true, stdout: 'b61ae485b61ae485\n' },
      [LOCAL_CURRENT]: { ok: true, stdout: '' },
      [HEAD_BRANCH]: headRef('cez/ab12cd34'),
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'deadbeefdeadbeef',
    });
    expect(calls).not.toContainEqual(['merge-base', 'origin/main', 'HEAD']);
  });

  it('on a DIVERGED base, keeps the local ref when the task forked from it', async () => {
    // A zero-config task forked from the user's own diverged branch (keepDiverged).
    const { run } = stubGit({
      [HAS_REMOTE]: { ok: true, stdout: 'b61ae485b61ae485\n' },
      [LOCAL_CURRENT]: { ok: false, stdout: '', code: 1 },
      [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' },
      [MERGE_BASE]: { ok: true, stdout: 'localtiplocaltip\n' },
      [MERGE_BASE_REMOTE]: { ok: true, stdout: 'olderolderolder0\n' },
      'merge-base --is-ancestor olderolderolder0 localtiplocaltip': { ok: true, stdout: '' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'localtiplocaltip',
    });
  });

  it('on a DIVERGED base, measures against origin when the task forked from origin', async () => {
    // A configured base: stale diverged local main, the task forked from origin/main.
    const { run } = stubGit({
      [HAS_REMOTE]: { ok: true, stdout: 'b61ae485b61ae485\n' },
      [LOCAL_CURRENT]: { ok: false, stdout: '', code: 1 },
      [HEAD_BRANCH]: { ok: true, stdout: 'cez/ab12cd34\n' },
      [MERGE_BASE]: { ok: true, stdout: 'olderolderolder0\n' },
      [MERGE_BASE_REMOTE]: { ok: true, stdout: 'freshfreshfresh0\n' },
    });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'freshfreshfresh0',
    });
  });

  it('leaves an already-remote base and a pinned commit sha alone', async () => {
    const { run, calls } = stubGit({ 'merge-base origin/develop HEAD': { ok: true, stdout: 'abc123abc123\n' } });

    expect(await resolveTaskDiffBase(run, 'origin/develop')).toEqual({ base: 'abc123abc123' });
    // No `origin/origin/develop` probe — the ref is already the remote's answer.
    expect(calls).toEqual([['merge-base', 'origin/develop', 'HEAD']]);
  });

  it('falls back to the base branch name when the merge-base cannot be resolved', async () => {
    const { run } = stubGit({ ...NO_REMOTE, [HEAD_BRANCH]: headRef('cez/ab12cd34') });

    expect(await resolveTaskDiffBase(run, 'main', { taskBranch: 'cez/ab12cd34' })).toEqual({
      base: 'main',
    });
  });
});

describe('resolveTaskDiffBase — a repointed HEAD', () => {
  /** A review run: the checked-out branch already carried its own history. */
  const reviewRun = {
    ...NO_REMOTE,
    [HEAD_BRANCH]: headRef('review/pr-694'),
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
      [HEAD_BRANCH]: headRef('review/pr-694'),
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
      [HEAD_BRANCH]: headRef('review/pr-694'),
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
      [HEAD_BRANCH]: headRef('review/pr-694'),
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
      [HEAD_BRANCH]: headRef('HEAD'),
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
      [HEAD_BRANCH]: headRef('review/pr-694'),
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
    expect(calls).not.toContainEqual(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
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
    expect(calls).not.toContainEqual(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
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

describe('resolveTaskDiffBase — memoization', () => {
  const CACHE_SETUP = {
    ...NO_REMOTE,
    [HEAD_BRANCH]: headRef('review/pr-694'),
    [MERGE_BASE]: { ok: true, stdout: 'anchoranchoranchor' },
    [BASELINE]: { ok: true, stdout: 'baselinebaseline' },
    'diff --shortstat baselinebaseline': { ok: true, stdout: ' 1 file changed, 1 insertion(+)\n' },
    'diff --shortstat anchoranchoranchor': { ok: true, stdout: ' 1 file changed, 2 insertions(+)\n' },
  };

  it('reuses the resolved anchor while HEAD is unchanged, re-probing only HEAD', async () => {
    clearTaskDiffBaseCache?.();
    const { run, calls } = stubGit(CACHE_SETUP);
    const opts = { taskBranch: 'cez/ab12cd34', runStartedAt: STARTED_AT, cacheKey: '/wt/a' };
    const first = await resolveTaskDiffBase(run, 'main', opts);
    const afterFirst = calls.length;
    const second = await resolveTaskDiffBase(run, 'main', opts);
    expect(second).toEqual(first);
    // A hit validates the sha and the branch and stops: no reflog lookup, no shortstat comparison.
    expect(calls.slice(afterFirst)).toEqual([['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']]);
  });

  it('recomputes when the fetched origin/<base> tip moves under an unchanged HEAD', async () => {
    clearTaskDiffBaseCache?.();
    const answers: Record<string, { ok: boolean; stdout: string; code?: number }> = {
      [HAS_REMOTE]: { ok: true, stdout: 'tipone...\n' },
      [LOCAL_CURRENT]: { ok: false, stdout: '', code: 1 },
      [HEAD_BRANCH]: headRef('review/pr-694'),
      [MERGE_BASE_REMOTE]: { ok: true, stdout: 'anchoranchoranchor' },
      [BASELINE]: { ok: true, stdout: 'baselinebaseline' },
      'diff --shortstat baselinebaseline': { ok: true, stdout: ' 1 file changed, 1 insertion(+)\n' },
      'diff --shortstat anchoranchoranchor': { ok: true, stdout: ' 1 file changed, 2 insertions(+)\n' },
    };
    const { run, calls } = stubGit(answers);
    const opts = { taskBranch: 'cez/ab12cd34', runStartedAt: STARTED_AT, cacheKey: '/wt/e' };
    await resolveTaskDiffBase(run, 'main', opts);
    const afterFirst = calls.length;
    // A fetch advanced origin/main; HEAD did not move, so the sha/branch guard
    // alone would have served the stale anchor.
    answers[HAS_REMOTE] = { ok: true, stdout: 'tiptwo...\n' };
    await resolveTaskDiffBase(run, 'main', opts);
    expect(calls.slice(afterFirst)).toContainEqual(['merge-base', 'origin/main', 'HEAD']);
  });

  it('recomputes once HEAD moves under the same worktree key', async () => {
    clearTaskDiffBaseCache?.();
    const answers = { ...CACHE_SETUP };
    const { run, calls } = stubGit(answers);
    const opts = { taskBranch: 'cez/ab12cd34', runStartedAt: STARTED_AT, cacheKey: '/wt/b' };
    await resolveTaskDiffBase(run, 'main', opts);
    const afterFirst = calls.length;
    answers[HEAD_BRANCH] = { ok: true, stdout: `newheadnewheadnew00\nreview/pr-694\n` };
    await resolveTaskDiffBase(run, 'main', opts);
    // A moved HEAD misses, so the full decision runs again.
    expect(calls.slice(afterFirst)).toContainEqual(['merge-base', 'main', 'HEAD']);
  });

  it('recomputes when HEAD returns to the task branch at the same commit', async () => {
    clearTaskDiffBaseCache?.();
    const answers = {
      ...CACHE_SETUP,
      // A sha-only validator would read this and wrongly accept the cached repoint.
      'rev-parse HEAD': { ok: true, stdout: `${HEAD_SHA}\n` },
    };
    const { run, calls } = stubGit(answers);
    const opts = { taskBranch: 'cez/ab12cd34', runStartedAt: STARTED_AT, cacheKey: '/wt/d' };
    await resolveTaskDiffBase(run, 'main', opts);
    const afterFirst = calls.length;
    // Same sha, now on the task branch: the sha alone cannot tell the branches
    // apart, so the memo must validate the branch too and drop the stale repoint.
    answers[HEAD_BRANCH] = headRef('cez/ab12cd34');
    const second = await resolveTaskDiffBase(run, 'main', opts);
    expect(second).toEqual({ base: 'anchoranchoranchor' });
    expect(calls.slice(afterFirst)).toContainEqual(['merge-base', 'main', 'HEAD']);
  });

  it('never memoizes the cheap non-repointed answer', async () => {
    clearTaskDiffBaseCache?.();
    const { run, calls } = stubGit({
      ...NO_REMOTE,
      [HEAD_BRANCH]: headRef('cez/ab12cd34'),
      [MERGE_BASE]: { ok: true, stdout: 'deadbeefdeadbeef\n' },
    });
    const opts = { taskBranch: 'cez/ab12cd34', cacheKey: '/wt/c' };
    await resolveTaskDiffBase(run, 'main', opts);
    const afterFirst = calls.length;
    await resolveTaskDiffBase(run, 'main', opts);
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});
