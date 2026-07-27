/**
 * Optional diff-first review gate (#489, spec `2026-07-18-optional-review-gate`).
 *
 * The review gate (spec 009) used to fire for EVERY successful run whose worktree
 * held changes — parking it at `review` until a human accepts. This resolver makes
 * that opt-in. It mirrors `liveTitleUpdatesEnabled` (`src/runs/auto-name.ts`) but
 * with the OPPOSITE default: OFF unless explicitly turned on.
 *
 * Precedence: the `config.reviewGate` Settings toggle wins when set; otherwise the
 * `CEZ_REVIEW_GATE` env decides — enabled ONLY by the exact string `'1'` (anything
 * else, including `'true'`/`'yes'`/unset, is off); otherwise off.
 *
 * Autonomy is applied by the callers, not here: a run parks at `review` only when
 * `worktreeHasDiff && reviewGateEnabled(config) && !run.autonomous`.
 */
export function reviewGateEnabled(
  config: { reviewGate?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.reviewGate !== undefined) return config.reviewGate;
  return env.CEZ_REVIEW_GATE === '1';
}
