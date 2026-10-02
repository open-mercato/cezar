/**
 * Forge-neutral `prDiff` caps (spec 2026-08-10-forge-provider-adapters, Step 3.5, Decision D4):
 * both adapters bound their pull/merge-request diff the same way, so the numbers live in one
 * place rather than two copies that could drift. `forge/github.ts` keeps `GH_PR_DIFF_FILE_CAP` /
 * `GH_PR_PATCH_CAP` / `GH_PR_DIFF_JSON_CAP` exported as aliases of these — same values, so nothing
 * about GitHub's behaviour changes — because the diff already imports the old names.
 */

/** Max files a `prDiff` result carries — the 3rd page of a 100-per-page file listing. */
export const FORGE_PR_DIFF_FILE_CAP = 300;

/** Max bytes a single file's `patch` may occupy before it is dropped as `'too-large'`. */
export const FORGE_PR_PATCH_CAP = 512 * 1024;

/** Max bytes the whole `{files: […]}` payload may serialize to before trailing files are dropped. */
export const FORGE_PR_DIFF_JSON_CAP = 4 * 1024 * 1024;

/**
 * The bounded-pagination budget both adapters' multi-page reads run under (`fetchBoundedPages`).
 * Kept here rather than in `github.ts` so the GitLab adapter does not need the GitHub module to
 * evaluate before its own module-level constants can be computed.
 */

/** `gh api --paginate` has no page limit, so the timeline fetch hand-rolls a bounded loop. */
export const TIMELINE_MAX_PAGES = 10;
/** ONE budget shared by every page. `gh()`'s timeout is per invocation, so ten pages at the 15 s
 *  default would put the ceiling at 150 s — an order of magnitude worse than the single
 *  `--paginate` spawn this replaces. The loop tracks a deadline and passes what's left. */
export const TIMELINE_BUDGET_MS = 15_000;
/** Never spawn a page that cannot finish. A bare `remaining <= 0` guard catches only the exact
 *  boundary; the realistic case is 300 ms left, which spawns `gh` with a 300 ms timeout, throws,
 *  and is indistinguishable from a real endpoint failure. */
export const TIMELINE_MIN_PAGE_MS = 2_000;
