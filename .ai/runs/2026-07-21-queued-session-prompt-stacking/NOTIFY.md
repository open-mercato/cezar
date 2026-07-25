# Notify — 2026-07-21-queued-session-prompt-stacking

> Append-only log. Every entry is UTC-timestamped. Never rewrite prior entries.

## 2026-07-21T11:40:00Z — run started
- Brief: Implement the spec at `.ai/specs/2026-07-21-queued-session-prompt-stacking.md` (FR #472 — stack, edit and remove prompt messages on a queued run).
- External skill URLs: none
- Mode: Spec-implementation run (spec-driven, 11 Steps, new HTTP routes + new record field → heuristic rule 1).
- Engine chosen by `om-auto-implement-spec`: `om-auto-create-pr-loop` (11 Steps > the 8–10 threshold, UI work needing screenshots, no pre-existing spec PR — #537 is merged).
- Worktree: reused the existing linked cez worktree rather than nesting a new one.

## 2026-07-21T11:41:00Z — checkpoint 1 (after Step 1.5)
- Steps 1.1–1.5 landed, one commit each (`163e6ff`, `415d486`, `98d1858`, `dd83a3b`, `b7d8b55`).
- Gate: `npm run typecheck` clean; `npm test` **3010 passed / 175 files**, 0 failed. No regressions.
- UI checks skipped — correctly, nothing user-facing has landed yet (Phase 1 is engine + API). Screenshots deferred to the Phase 2 checkpoint.
- DECISION: stacked attachments ride a new `StartRunInput.stackedImages` field instead of `input.images`. `execute()` persists `input.images` into `taskImages`, so folding already-persisted files there would duplicate them on disk and make the task bubble claim the stack's images. Same delivery, no side effects.
- DECISION: `deferMessage` gates on a new `ActiveRun.sessionEverOpened` flag, not the `starting` set alone. `execute()` drops the run from `starting` seconds before the backend spawns, so gating on it would have reopened the exact dropped-message window rung 3 exists to close. `state.session` cannot substitute — teardown resets it to `undefined`, making a closed session indistinguishable from one that never opened.
- No subagents dispatched: the Phase 1 steps are tightly coupled (schema → mutators → hydration → routes) and the dispatcher pattern would have had each executor re-derive the same context.

## 2026-07-21T12:15:00Z — final gate passed, all 11 Steps done
- Gate: typecheck ✅ · `npm test` **3157/179 files** ✅ · `test:unit` ✅ · `build` ✅ · `test:package` ✅.
- E2E: `queued-stack.e2e.ts` 5/5 in a real browser, 4 screenshots captured.
- BLOCKER RESOLVED: the first cut of the e2e hung for 5 minutes and died on its timeout. Cause was my TEST, not the feature — it did `await fetch('/api/runs/:id/events').text()`, and that route is an SSE stream, so the promise never settles. Confirmed the feature itself works by driving a real server manually: the queue drains and the amended prompt reaches the agent's session (`notes.md` in the run's worktree carried the stacked text).
- DECISION: `origin/main` moved mid-run (67cdd2f → 8c22ab9) and #524 made `UserBubble` render markdown — the same component this work extends. Merged and kept BOTH; the inline editor edits the raw markdown source, not the rendered output. Re-verified with unit tests and a fresh browser run.
- Pre-existing e2e failures (settings/github/task-thread tabs) PROVEN pre-existing by checking out clean origin/main, rebuilding, and reproducing the identical 4 failures there.
- FINDING beyond scope: turning on the new `ExactKeys` mirror guard surfaced four RunRecord fields that had silently drifted out of the web mirror (`autonomous`, `referencedIssueUrl`, `referencedIssueCandidates`, `worktreeReclaimedAt`). Mirrored them — shipping a knowingly-failing guard was not an option.

## 2026-07-21T12:25:00Z — review pass complete, run finished
- `om-auto-review-pr` found 3 issues in my own diff, all fixed with regression tests, gate re-run after each batch (3160 tests green):
  1. MAJOR — `flushDeferred` dropped its buffer before sending, silently losing a message the session refused (the exact failure `deferMessage` exists to prevent).
  2. minor — bounds ran before the ladder resolved, so an over-long message to a finished run answered `400 prompt too long` instead of the truthful `409 session closed`.
  3. minor — affordances memoized on TanStack's mutation RESULT objects (fresh each render), rebuilding every thread row per render and defeating the virtualization memo.
- VERDICT: no blockers remain. Posted as a COMMENT, not a formal review: GitHub refuses `addPullRequestReview` on your own PR. Pipeline label deliberately left at `review` (not `merge-queue`) — this PR has no formal approval and needs a human one.
- Labels: review, feature, needs-qa, priority-medium, risk-medium. PR flipped to ready. Manual-QA instructions posted.
- Lock released.
