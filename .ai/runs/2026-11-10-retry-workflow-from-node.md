# Retry a failed workflow run from a chosen node (#1733)

Goal: let a user re-enter a failed workflow's graph at a node cezar runs itself, without a restart.

Scope: `POST /api/v1/runs/:id/retry { node }` (contract schema first, chained, validated as middleware),
`RunManager.retryRun` reusing `recover()`'s cursor resume through `reviveQueuedRun`, and a
"Retry from…" action on a failed workflow run in the task view.

Decisions on the triage questions (issue comments):
- Eligible: `failed`; `done`/`review` only when the walk's last edge left a `fail`/`failed` port or a
  non-continuation step is `failed`.
- Branch: adopt the branch the worktree holds when it exists and the tree is clean (record + lifecycle
  record); refuse with a reason otherwise. The open PR is untouched — the record now matches its head.
- Concurrency: re-queued, so `maxParallel` holds.
- Children: out of scope; fork/join/dispatch/workflow nodes are not retry targets.
- Reset: the node's step back to `pending`, its own stale output dropped, the walk truncated at its
  last departure; loop counters and other outputs kept. Leftover `continue-N` steps settle `skipped`.

Non-goals: retrying agent nodes (Continue covers them), resetting child tasks.

Risks: lifecycle changes on a run record; covered by engine tests proven red without the fix.

## Progress

PR: #2050

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server

- [x] 1.1 Contract schemas, engine retryRun, route, regression tests — 8a2229c24, 35adfe6b8

### Phase 2: Cockpit

- [x] 2.1 "Retry from…" action on a failed workflow run, with unit test — 19ddf392a
