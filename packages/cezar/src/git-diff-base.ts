/**
 * "Which ref anchors *this task's* diff" — the single rule every task-diff
 * surface resolves through (#751).
 *
 * The normal answer is `merge-base(baseBranch, HEAD)`: it keeps a task's diff
 * to the task's own commits even after the base branch moves on, and even
 * after the task merges the base back in.
 *
 * The exception is a **repointed HEAD**. cezar hands the agent a worktree on
 * the task's own branch, but nothing stops the agent from checking out some
 * other branch in it — every `review/pr-NNN`, QA, and "continue someone
 * else's branch" run does exactly that. Anchoring at the merge-base then
 * silently redefines "this task's diff" as *the whole reviewed branch*, which
 * is how a task that committed nothing came to report `+22505 −2628`. When
 * HEAD is not on the task's branch the honest anchor is `HEAD` itself: the
 * uncommitted work in the tree is the only part this task can be said to have
 * produced.
 *
 * #591 established that rule for the Changes tab; #751 found the sidebar and
 * Tasks-table numbers still on the old anchor. It lives here so a third
 * surface cannot get it wrong again — callers hand in their own `git` runner
 * (`git-worktree.ts` and `server/git-changes.ts` each own a private one, and
 * `git-changes` needs its scratch-`GIT_INDEX_FILE` variant), so this module
 * stays a pure decision with no process-spawning of its own.
 */

/** What a caller's `git` runner must answer with. Both existing runners are wider than this. */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
}

/** A caller-supplied `git` invocation, already bound to a working directory (and env). */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

/** The task branch cezar created vs. the branch HEAD actually sits on. */
export interface RepointedHead {
  headBranch: string;
  taskBranch: string;
}

export interface TaskDiffBase {
  /** The ref to diff against. */
  base: string;
  /** Present only when HEAD left the task's branch — the reason `base` is `HEAD`. */
  repointedHead?: RepointedHead;
}

/**
 * Resolve the diff anchor for a task worktree. Never throws: a failing git
 * call degrades to the base branch name, which is what the un-guarded callers
 * did before this helper existed.
 *
 * `taskBranch` is optional because not every caller has one (the main working
 * tree has no task branch at all). Without it there is nothing to compare
 * HEAD against, so the merge-base anchor is used unchanged — that is the
 * pre-#751 behavior, preserved exactly.
 *
 * A detached HEAD (`rev-parse --abbrev-ref HEAD` → `HEAD`) counts as
 * repointed: it is by definition not the task's branch, so the same
 * uncommitted-only anchor is the honest one.
 */
export async function resolveTaskDiffBase(
  runGit: GitRunner,
  baseBranch: string,
  opts: { taskBranch?: string } = {},
): Promise<TaskDiffBase> {
  if (opts.taskBranch) {
    const headBranchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const headBranch = headBranchResult.ok ? headBranchResult.stdout.trim() : '';
    // An unreadable HEAD (no commits yet, broken worktree) is NOT evidence of a
    // repoint — fall through to the merge-base anchor rather than narrowing on a
    // guess.
    if (headBranch && headBranch !== opts.taskBranch) {
      return { base: 'HEAD', repointedHead: { headBranch, taskBranch: opts.taskBranch } };
    }
  }
  const mergeBase = await runGit(['merge-base', baseBranch, 'HEAD']);
  return { base: mergeBase.ok && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : baseBranch };
}
