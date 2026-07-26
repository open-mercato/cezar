/**
 * Council resilience: what survives a reviewer that doesn't.
 *
 * The rule this replaces was "a partial council is no council" — any reviewer
 * that failed to produce a valid review killed the entire run. That is correct
 * as a principle and disastrous as an implementation: a run that had already
 * spent 5.3M tokens and $12, with two reviewers' findings written to disk, was
 * discarded because a third (a free-tier model) could not finish inside its
 * budget. The user got nothing, twice over, for work that was 2/3 done.
 *
 * The principle survives as a QUORUM. A council means independent voices, so
 * "accept whatever we got" is not the answer either. What must hold is:
 *
 *   - at least two reviewers completed, and
 *   - those survivors span at least two independent families.
 *
 * Both mirror the constraint the server already enforces when a run is
 * submitted, so a degraded round is never weaker than a round the user could
 * have configured on purpose. When a reviewer drops but quorum holds, the round
 * proceeds and is marked `degraded` — the caller is expected to record and
 * surface that, never to swallow it.
 */

export interface CouncilOutcome {
  /** `roleRefId` of the reviewer. */
  label: string;
  status: 'completed' | 'failed';
  /** Independence axis. Under-counting here fails safe (toward refusing). */
  family?: string;
  /** Why it failed — carried into the operator-facing message. */
  reason?: string;
}

export type CouncilQuorum =
  | { ok: true; degraded: boolean; completed: CouncilOutcome[]; failed: CouncilOutcome[] }
  | { ok: false; reason: string };

/** Minimum reviewers that must complete for the round to mean anything. */
const MIN_REVIEWERS = 2;
/** Minimum independent families among the survivors. */
const MIN_FAMILIES = 2;

export function councilQuorum(outcomes: readonly CouncilOutcome[]): CouncilQuorum {
  const completed = outcomes.filter((o) => o.status === 'completed');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const describeFailures = () =>
    failed.map((f) => `${f.label} (${f.reason ?? 'no valid review'})`).join('; ');

  if (completed.length < MIN_REVIEWERS) {
    return {
      ok: false,
      reason:
        `only ${completed.length} of ${outcomes.length} reviewers produced a valid review — ` +
        `a council needs at least ${MIN_REVIEWERS}` +
        (failed.length ? `. Failed: ${describeFailures()}` : ''),
    };
  }

  const families = new Set(completed.map((o) => o.family ?? o.label));
  if (families.size < MIN_FAMILIES) {
    return {
      ok: false,
      reason:
        `the surviving reviewers span only ${families.size} independent family — ` +
        `a council needs at least ${MIN_FAMILIES}, otherwise nothing was cross-checked` +
        (failed.length ? `. Failed: ${describeFailures()}` : ''),
    };
  }

  return { ok: true, degraded: failed.length > 0, completed, failed };
}

/**
 * Whether a second attempt could plausibly differ.
 *
 * A timeout means the reviewer consumed its entire budget. Retrying hands it
 * the same budget and the same prompt, so it fails the same way — observed
 * live as two consecutive 60-minute timeouts on one reviewer, two hours spent
 * to learn the same thing twice. Everything else (a crashed CLI, a dropped
 * connection, a malformed result) can genuinely differ on a retry.
 */
export function isRetryableReviewerFailure(failure: string): boolean {
  return !/timed?\s?out|timeout/i.test(failure);
}

/** How many council reviewers may run at once. The om runtime this was ported
 *  from fans reviewers out with `pool(profile.reviewers, profile.maxParallel)`
 *  at `maxParallel: 5`; cezar serialized them, so a 3-reviewer council took 3×
 *  the wall clock for no reason (2026-07-25). Bounded rather than unlimited —
 *  each reviewer is a whole CLI session. */
export const MAX_PARALLEL_REVIEWERS = 5;

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the results. Mirrors the om runtime's `pool`.
 *
 * Rejections are NOT caught here: a council caller is expected to convert each
 * item's failure into an outcome inside `fn`, so one reviewer blowing up can
 * never take its siblings down with it.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}
