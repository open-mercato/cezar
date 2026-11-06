# Checkpoint 4 — Steps 3.1..3.5 + 3.2-review-fix

**When:** 2026-09-22T15:16:05Z
**Steps:** 3.1–3.5, 3.2-review-fix (`8209bd0d`..`927f232b`)
**Touched areas:** new `server/forge/gitlab.ts` (+ tests), new `server/forge/limits.ts`, `forge/index.ts` (GitLab registration), `forge/github.ts` (cap aliases), github*-api tests, health-forge test

| Check | Result | Notes |
|---|---|---|
| `npm run typecheck` | ✅ pass | |
| `npm test` | ✅ pass (1 flake) | 7 477 / 7 478. The failure, `web/routes/github/github.test.tsx` "inserting a second template stacks it below the first", is a textarea-value timing assertion under full-suite load; passes 3/3 alone; the branch changes no file it covers (only `project-groups.tsx` in `packages/web`). |
| `npm run test:unit` | ✅ pass | 36 / 36 |
| UI verification | ⏭️ skipped | No Step in the window touched `packages/web`. |

## What the GitLab driver answers now
detect/detectCached (`glab repo view --output json`, SWR cache, web_url cached), listAll/listIssues/listPRs (open items, cap 100 per kind = GitLab's page ceiling, `truncated` flag), listComments (notes + label/state events + recognised system notes, existing allowlist only), listChecks (MR `head_pipeline`), prStatus (`--source-branch`), prDiff (`/diffs`, forge-neutral caps, 404 → existing mapping). Still absent: searchItems (3.6), viewUrl (3.7 — returns null), createPR (4.1 — returns an error), refStatus/merge (non-goals).

## Fix landed at this checkpoint
- 3.2-review-fix (`927f232b`): a flake introduced by this branch — the dry-run list test compared three calls that each read the clock; `Date` is now frozen in that test (5/5 green).
