# Notifications — GitHub timeline events

Append-only, UTC timestamps, newest at the bottom.

- **2026-07-21T00:00Z — run start.** `om-auto-fix-issue 525` classified #525 as a feature request
  and routed to the feature path. Spec `.ai/specs/2026-07-20-github-timeline-events.md` was already
  written and merged via PR #527, so no spec-authoring step was needed.
- **2026-07-21T00:00Z — decision: engine.** 20 Steps across 3 phases with UI work needing
  screenshots → `om-auto-create-pr-loop` rather than plain `om-auto-create-pr`.
- **2026-07-21T00:00Z — decision: branch reuse.** Working in the existing cez linked worktree
  rather than creating a nested one; branch cut fresh from `origin/main` (`67cdd2f`) so the merged
  spec is present.
- **2026-07-21T11:31Z — pre-existing failure identified.** `src/server/request-validation.test.ts`
  → "rejects an open-in with no target (400)" fails with 409≠400. Verified against a clean
  `origin/main` worktree: **fails there too**, so it is pre-existing drift, not this branch's doing.
  Not fixed here (out of scope); noted so the final gate is not misread as green-with-a-regression.
- **2026-07-21T11:32Z — checkpoint 1** (after Step 1.5). Phase 1 server side complete and green:
  typecheck clean, 101 forge tests passing, 30 new cases. UI verification skipped — nothing
  user-visible has changed yet (first UI step is 1.7). See `checkpoint-1-checks.md`.
- **2026-07-21T11:41Z — checkpoint 2** (after Step 2.5). Phases 1 and 2 complete: typecheck clean,
  1861 web tests + 115 forge tests passing. See `checkpoint-2-checks.md`.
- **2026-07-21T11:41Z — UI verification skipped, with reason.** `mockGithubComments` serves no
  fixture events yet, so a `CEZ_DRY_RUN=1` screenshot would show an event-free thread while looking
  like a pass. Deferred to checkpoint 3, immediately after Step 3.2 adds the fixtures.
- **2026-07-21T12:00Z — CORRECTION to the checkpoint-1 finding.** The `request-validation` failure
  is **not** repo drift: it fails only when `CEZ_REMOTE=1` leaks in from the surrounding cezar
  session. Comparing against `origin/main` did not expose that, because the variable was set for
  both runs. With it scrubbed, `npm test` is **3043/3043 green**. Conclusion ("not this branch")
  stood; the stated cause was wrong.
- **2026-07-21T12:00Z — final gate.** All five `validation.commands` pass. e2e: 6 failed on this
  branch vs **8 failed on a clean `origin/main`** — every failure pre-existing and environmental.
  `github.e2e.ts` isolated: base 2 failed/2 passed, branch 2 failed/**3** passed — same two
  pre-existing specs, the new one is the extra pass.
- **2026-07-21T12:00Z — UI verified.** `github-thread-timeline.png` shows the Activity header, a
  tinted label event, the 4-commit grouping, and per-commit ✓/✗ CI glyphs interleaved with comments.
- **2026-07-21T12:14Z — adversarial review found a REAL bug in my own Step 3.1.** A fresh-context
  reviewer showed the "refresh also invalidates the thread" fix was a **no-op**: `getGithubComments`
  had no `refresh` param at all, so the invalidate re-requested without `refresh=1` and the route
  handed back its ≤60 s cache. The test I wrote asserted the mechanism (a request went out), not
  the property (fresh data), so it passed with the bug fully present. Fixed both.
- **2026-07-21T12:14Z — review fixes landed.** refresh=1 plumbed through the client; three vacuous
  constant assertions replaced with a behavioural one; the tautological §2 test supplemented with a
  real captured timeline row; the index-fallback instability pinned honestly; the 40-hex sha
  invariant enforced at the boundary; same-second comment/event tie-order fixed (ms vs second
  precision made events always win). Gate re-run: **3045/3045**.
- **2026-07-21T12:24Z — the RE-REVIEW caught a regression my own fix batch introduced.** Keying the
  open thread off the `:n` route param left the **default landing pages** (`/github`, `/github/prs`)
  refreshing nothing, because with no `:n` the tab still renders a thread (`selected` falls back to
  `items[0]`) — so the original bug survived exactly where users land most. And the `removeQueries`
  predicate wiped that mounted query, flashing the loading skeleton on every refresh — a *new*
  regression the old invalidate-only code did not have. The refresh now follows the rendered
  `selected` via a ref. Two tests added for precisely these two cases.
- **2026-07-21T12:24Z — remaining re-review items fixed.** Unparseable `createdAt` (a bodied PENDING
  review yields `''`, and `Date.parse('')` is NaN, which makes the sort *inconsistent* rather than
  crashing) pinned deterministically; the cap test that could not have detected a combined cap
  supplemented with an end-to-end one asserting 200 comments **and** 200 events (400 total) from a
  single fetch; unused imports dropped. Gate: **3049/3049**.
