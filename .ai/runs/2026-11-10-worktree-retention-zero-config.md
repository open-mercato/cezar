# Worktree retention on every finished transition (#2003)

Source doc: .ai/specs/2026-07-18-worktree-retention.md

## Goal

The count-based retention (default 10) runs on every transition into a finished status, and
after a project retention save, with zero config.

## Root cause

`RunManager.enforceRetention` runs only from `dropActive`. A run usually settles at `review`,
which does not count, so `dropActive`'s pass reclaims nothing for it. It reaches `done` later
through paths that never pass through `dropActive`: Finish on a settled review (`finishRun`),
opening a PR (`POST /runs/:id/pr`), and boot recovery. No pass follows, so finished
worktrees pile up until an unrelated run settles or cezar restarts. A project Settings save
writes the key but starts no pass either, so a lowered limit looks ignored.

## Scope

- `RunManager`: watch store `run` updates for a status change into done/failed/cancelled on a
  run that is not active, and start one coalesced retention pass. `dropActive` keeps its own.
- `PUT /config`: a changed `worktreeRetention` starts a pass.
- Regression tests: absent config vs saved 10, review→done outside `dropActive`.

Non-goals: changing the default, byte budgets (#842), deleting branches, the lifecycle-gated
reclaim path (#1495), the global-default save.

## Risks

- A pass on a run that is still live: guarded by skipping runs in the active registry; the
  selector already skips `review`/live statuses and in-use worktrees.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix

- [ ] 1.1 Retention pass on finished transitions outside dropActive
- [ ] 1.2 Retention pass after a project retention save
- [ ] 1.3 Regression tests
