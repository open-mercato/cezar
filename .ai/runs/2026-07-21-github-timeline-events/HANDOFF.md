# Handoff — GitHub timeline events

**Updated:** 2026-07-21, checkpoint 2
**Branch:** `feat/github-timeline-events`
**PR:** [#552](https://github.com/open-mercato/cezar/pull/552) (draft)
**Spec:** `.ai/specs/2026-07-20-github-timeline-events.md`
**Issue:** #525

## Where things stand

**Phases 1 and 2 are complete and green** (Steps 1.1–2.5, twelve commits). The thread now
interleaves timeline events with comments, commits carry rolled-up CI glyphs, and consecutive
same-author commit runs collapse behind an `aria-expanded` expander.

typecheck clean; **1861 web tests** and **115 forge tests** passing.

Screenshots are deliberately deferred to checkpoint 3 — `mockGithubComments` has no fixture events
yet, so a dry-run screenshot today would show a thread with no events at all while looking like a
pass. Step 3.2 fixes that.

## Next Step

**3.1** — the refresh mutation at `github.tsx` invalidates only `queryKeys.github({limit: FULL_LIMIT})`,
never open `queryKeys.githubComments` keys, so a manual refresh leaves the open thread stale for up
to 60 s. Pre-existing, but in scope because it now hides commits too. Then 3.2 (dry-run fixtures —
unblocks screenshots), 3.3–3.6 (type pins, route assertions, §2 inventory + drift guard), 3.7 (e2e),
3.8 (full gate).

## Resume in 30 seconds

1. `git checkout feat/github-timeline-events && npm ci`
2. `PLAN.md` Tasks table — first `todo` row is next.
3. **Read `PLAN.md`'s "Load-bearing details" before touching `src/server/forge/github.ts`.** Those
   nine points are live-API facts; several have a naive implementation that is silently wrong.
4. One commit per Step; flip the Tasks row in the same commit.

## Gotchas found so far

- **A page-insensitive `gh` mock hides paging bugs.** The fixtures in
  `fetchGithubComments timeline integration` are page-aware for a reason — don't simplify them.
- **`src/server/request-validation.test.ts` has one failure that is pre-existing on `main`**
  (409 ≠ 400). Verified against a clean base worktree. Not this branch's; don't chase it.
- `noUncheckedIndexedAccess` is on — indexed access in tests needs `!`.
- **Two same-author commits in a fixture now collapse into a group.** If a component test suddenly
  finds fewer `gh-event-row`s than it expects, that is Step 2.5 working, not a bug — give the
  commits distinct authors when the test is about something other than grouping.

## Blockers

None.
