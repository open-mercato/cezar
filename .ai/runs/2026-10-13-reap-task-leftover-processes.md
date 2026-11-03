# Reap processes a task leaves behind (#1411)

## Goal

When a task settles, no process it started keeps running: cezar finds every process still carrying
the task's `CEZ_TASK_ID` environment marker and stops it (SIGTERM, then SIGKILL), and on boot it does
the same for runs that settled while cezar was down.

## Scope

- New `packages/cezar/src/core/task-processes.ts`: list processes by their `CEZ_TASK_ID` env marker
  (Linux `/proc/<pid>/environ`; macOS `ps -E`; Windows: none), excluding cezar itself and its
  ancestors; reap with SIGTERM → grace → SIGKILL, re-listing before each signal (pid reuse).
- `RunManager.dropActive` (every terminal path) schedules the reap after a short settle grace and
  aborts when the run became active again (Continue). Reaped processes are logged on the run as a
  lifecycle event.
- `RunManager.recover` (boot, per project) sweeps processes of runs in this store that are not live.
- Dispatch prompt: one line of agent guidance (`timeout` host binaries, no `pkill -f` on generic
  patterns, check `ps` before reporting).
- `CEZ_TASK_PROCESS_REAP=0` kill switch, documented in `.env.example` and `docs/reference.md`.

Why the env marker and not cwd/cgroups: `CEZ_TASK_ID` is already set for every agent and inherited by
every descendant, re-parented and `setsid`ed ones included; it never matches the user's own shells in
the worktree. It also catches orphans from cezar versions before this fix.

## Non-goals

- systemd scopes / cgroups, `CPUQuota`/`MemoryMax`.
- A periodic scan, and a cockpit list with a one-click stop (the boot sweep reaps instead).
- Windows reaping.
- Adding reaped processes to a dispatched child's `side_effects` report (the report is written
  before the reap; after the reap nothing is left running to report).

## Risks

- Killing something the user wanted: only processes whose environment names a SETTLED run of this
  project are touched; a Continue within the grace aborts the reap.
- macOS `ps -E` parsing is untested on a real Mac here (no Mac available); failure degrades to no
  reaping.

## Implementation Plan

### Phase 1: Process discovery and reaping

- 1.1 `task-processes.ts` with pure parsers + list/reap, unit tests.

### Phase 2: Lifecycle wiring

- 2.1 Reap on settle in `dropActive`, boot sweep in `recover`, kill switch + docs, tests.
- 2.2 Agent guidance line in the dispatch prompt.

## Progress

PR: #1419

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Process discovery and reaping

- [x] 1.1 task-processes module with parsers, list and reap, plus unit tests — a39739fa

### Phase 2: Lifecycle wiring

- [x] 2.1 Reap on settle and boot sweep in RunManager, kill switch and docs — 3eddf704
- [x] 2.2 Agent guidance line in the dispatch prompt — 9bf2a8e4

### Review fixes

- [x] R.1 Batch the /proc scan (review finding) — 807fb9c8
