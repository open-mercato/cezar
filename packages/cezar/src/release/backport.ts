/** Which merged PRs still need a backport — the pure half of `scripts/backport-queue.mts`.
 *
 *  The Backport workflow scans recently merged PRs in the repository's own context rather than
 *  reacting to PR events, so a fork PR (whose events carry no secrets) is backported like any
 *  other. The `backport <branch>` label is the only source of truth: a backport is done while an
 *  open or merged backport PR exists, and removing the label is how it is stopped. */

/** The label that asks for a backport: `backport release/vX.Y.x` or `backport main`. */
export const BACKPORT_LABEL = /^backport (main|release\/v\d+\.\d+\.x)$/;

/** The branch the Backport action names a backport after (its `branch_name` default). */
export function backportBranch(pr: number, target: string): string {
  return `backport-${pr}-to-${target}`;
}

export interface MergedPull {
  number: number;
  /** The branch it merged into; a backport to it would be a no-op. */
  base: string;
  labels: readonly string[];
}

/** `closed-branch-kept`: closed unmerged, but its branch still exists. The action would reuse
 *  that stale branch (its push-failure recovery) rather than cherry-pick afresh, so it waits. */
export type BackportState = 'open' | 'merged' | 'closed' | 'closed-branch-kept';

export interface BackportJob {
  pr: number;
  target: string;
}

/**
 * Every (PR, target) a label asks for that has no open or merged backport PR yet. A closed,
 * unmerged one does not count once its branch is deleted: the label still asks, so it is opened
 * again (remove the label to stop). Targets that do not exist as branches are skipped.
 */
export function planBackports(input: {
  pulls: readonly MergedPull[];
  /** State of the backport PR on `backportBranch(pr, target)`, when one exists. */
  existing: ReadonlyMap<string, BackportState>;
  branches: ReadonlySet<string>;
}): BackportJob[] {
  const jobs: BackportJob[] = [];
  for (const pull of input.pulls) {
    for (const label of pull.labels) {
      const target = BACKPORT_LABEL.exec(label)?.[1];
      if (!target || target === pull.base || !input.branches.has(target)) continue;
      const state = input.existing.get(backportBranch(pull.number, target));
      if (state !== undefined && state !== 'closed') continue;
      jobs.push({ pr: pull.number, target });
    }
  }
  return jobs.sort((a, b) => a.pr - b.pr || a.target.localeCompare(b.target));
}
