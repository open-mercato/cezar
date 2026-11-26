# Deleted project root: removable project, no 500 on End session

## Goal

A project whose folder was deleted from disk while a task was waiting can still be
removed from cezar, and ending or cancelling that task never answers 500.

## Scope

- `packages/cezar/src/server/server.ts` — `DELETE /projects/:id`: a project whose root is
  gone (or no longer a git repo) cancels its active runs instead of refusing with
  "has N running tasks".
- `packages/cezar/src/workflows/run.ts` — `finish` (and the path it reaches) must not throw
  when the run's worktree / root is gone.
- Regression tests for both.

## Non-goals

- Re-checking every cached project context on every request.
- Changing what `dispose()` does to live providers on an ordinary removal.
- Store `mkdir -p` recreation of a deleted data dir (noted under Risks; separate follow-up).

## Implementation Plan

### Phase 1: Removal of a project whose root is gone

- 1.1 Remove route: when the registry row's root is missing or not a git repo, cancel active
  runs and proceed; keep the refusal for a healthy root. Tests.

### Phase 2: End session on a deleted root

- 2.1 Make `finish` survive a deleted worktree/root (root cause from reproduction). Tests.

## Risks

- Cancelling runs on removal kills agent processes; only done when the root is already gone.
- The exact `finish` throw is being reproduced; if it cannot be, the route catches and
  falls back to cancel.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Removal of a project whose root is gone

- [x] 1.1 Remove route cancels active runs when the root is gone — 94cfc436

### Phase 2: End session on a deleted root

- [ ] 2.1 finish survives a deleted worktree/root
