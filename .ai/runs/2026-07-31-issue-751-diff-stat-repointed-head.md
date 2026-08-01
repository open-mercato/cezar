# Execution plan — task diff stat must not count a repointed HEAD's branch (#751)

**Issue:** [#751](https://github.com/open-mercato/cezar/issues/751)
**Branch:** `fix/issue-751-diff-stat-repointed-head`
**Base:** `main`

## Goal

Make `RunRecord.diffStat` — the `+adds −dels` pair the sidebar quick list and the Tasks table
show — report only the diff the task itself produced, instead of the whole diff of whatever
branch the agent checked out into the worktree.

## Background

`worktreeShortstat` (`packages/cezar/src/git-worktree.ts`) anchors its `git diff --shortstat` at
`merge-base(baseBranch, HEAD)` without ever asking whether HEAD is still on the task's own
branch. Every review, QA, or "continue someone else's branch" run repoints HEAD, so the stored
number becomes the reviewed branch's full diff against `main` — five-figure numbers on tasks that
changed nothing.

The Changes tab already solved exactly this in #591: `collectChanges`
(`packages/cezar/src/server/git-changes.ts`) takes `opts.taskBranch`, compares it against
`git rev-parse --abbrev-ref HEAD`, and anchors at `HEAD` (uncommitted work only) when the two
differ, returning `repointedHead` so the UI can explain the narrowed number. `worktreeShortstat`
never got the same guard, so today the two surfaces disagree for precisely these runs.

## Scope

- Extract the "which ref anchors this task's diff" decision into **one** helper both surfaces
  share, so this rule cannot be got wrong a third time.
- Add the repointed-HEAD guard to `worktreeShortstat` and thread `run.branch` through its single
  call site in `RunManager.recordTurnEnd`.
- Persist an **optional** `repointed` flag on `RunRecord.diffStat` and surface it in
  `DiffStatLabel`, so a narrowed number reads as honest rather than merely smaller.
- Document why `worktreeDiff` / `worktreeDiffStat` deliberately keep the whole-branch anchor.

## Non-goals

- The Changes tab's behavior (#591 is correct and stays as is).
- Reworking `autosaveCommit` or excluding agent-produced artifacts from the worktree — the
  second inflator named in the issue, worth its own issue.
- Backfilling or recomputing `diffStat` for historical runs: existing records keep their
  inflated numbers until the run's next turn-end.
- Changing `worktreeDiff`'s anchor. `GET /api/runs/:id/diff` is a protected surface in
  `BACKWARD_COMPATIBILITY.md` and `settleSuccess`'s review-gate test reads the same function;
  narrowing either is a behavior change wider than this issue, so those sites get a comment
  pointing at the shared helper instead.

## Implementation Plan

### Phase 1: One shared anchor rule, and the guard on `worktreeShortstat`

- **1.1** Add `packages/cezar/src/git-diff-base.ts`: `resolveTaskDiffBase(runGit, baseBranch, { taskBranch })`
  returning `{ base, repointedHead? }`, taking an injected git runner so both `packages/cezar/src/git-worktree.ts`
  and `packages/cezar/src/server/git-changes.ts` (which each own a private `git()`) can use it without either
  importing the other. Unit tests for the on-branch, repointed, detached, no-`taskBranch`, and
  merge-base-failure cases.
- **1.2** Rewrite `collectChanges` to call the helper, proving the extraction is behavior-preserving
  against the existing #591 tests.
- **1.3** Give `worktreeShortstat` an `opts: { taskBranch?: string }` parameter routed through the
  same helper; keep the existing contract (never throws, `null` on git failure, all-zeros for an
  empty diff). Thread `run.branch` at the single call site in `RunManager.recordTurnEnd`
  (`packages/cezar/src/workflows/run.ts`). Tests in `packages/cezar/src/git-worktree.test.ts` (repointed, on-branch, and
  no-`taskBranch` cases) and `packages/cezar/src/workflows/run.test.ts` (the stat stored for a repointed run).

### Phase 2: Make the narrowed number honest in the UI

- **2.1** Add optional `repointed?: boolean` to the persisted `diffStat` shape
  (`packages/cezar/src/runs/store.ts` zod schema) and to `packages/contract/src/runs.ts`; `worktreeShortstat` sets it
  only when the head is repointed, so the key is absent on every normal run and every pre-existing
  record still parses.
- **2.2** Surface it in `DiffStatLabel` (`packages/web/src/components/diff-stat.tsx`): a `title` tooltip
  that says the number covers uncommitted changes only because HEAD is on another branch, a
  `data-repointed` attribute for the surfaces to key on, and a dotted underline + `cursor-help`
  so the annotation is discoverable. Component tests, plus coverage through the sidebar quick list
  and the Tasks table.

### Phase 3: Close the loop on the third surface

- **3.1** Document on `worktreeDiff` / `worktreeDiffStat` why they keep the whole-branch anchor and
  where the task-diff rule now lives; add the `diffStat.repointed` note to
  `BACKWARD_COMPATIBILITY.md`'s `runs.json` section.

## Risks

- **Persisted-schema addition.** `runs.json` is `safeParse`d as a whole array, so a required field
  would silently drop every pre-existing run. `repointed` is optional and only ever written when
  true — mitigated by the schema being additive and by a store round-trip test.
- **A number that visibly drops.** Repointed runs will show far smaller values than before. That is
  the fix, but it is also a surprise, which is what the tooltip and the `data-repointed` marker
  exist to explain.
- **Refactor regression in `collectChanges`.** The extraction is covered by the existing #591 tests
  in `packages/cezar/src/server/git-changes.test.ts`, which must stay green untouched.

## Progress

PR: #759

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: One shared anchor rule, and the guard on `worktreeShortstat`

- [x] 1.1 Add the shared `resolveTaskDiffBase` helper with unit tests — 2115804e
- [x] 1.2 Rewrite `collectChanges` to use the shared helper — b1097da0
- [x] 1.3 Guard `worktreeShortstat` and thread `run.branch` from `recordTurnEnd` — 2669c3fd

### Phase 2: Make the narrowed number honest in the UI

- [x] 2.1 Persist the optional `repointed` flag on `diffStat` — 20a78ad4
- [x] 2.2 Annotate `DiffStatLabel` and cover the consuming surfaces — 9c648c52

### Phase 3: Close the loop on the third surface

- [x] 3.1 Document the `worktreeDiff` anchor decision and the schema addition — 3f042977
- [x] Post-review fix: name the repointed caveat for assistive tech (`aria-label`) and simplify the `collectChanges` call site — ff1f3541
- [x] Post-re-review fix: scope the repointed caveat to when it was measured, so it cannot outlive a reclaimed worktree — 7cca95c1
