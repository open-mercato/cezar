# Keep task worktrees from filling the disk

Customer report: `<project>/.ai/cezar/worktrees` grew to 17 GB on a VPS while the rest of
`.ai/cezar` stayed under 100 MB. Every task worktree is a full checkout, often with
`node_modules` or build output, so each can be 1–2 GB. Count retention (#483) only covered
`done`/`failed`/`cancelled`; `review` and `waiting` trees stayed forever, and archive freed nothing.

## Decisions

1. **Age retention.** A non-active run's tree is reclaimed after N days without activity.
   - Repo `.ai/cezar/config.json` `worktreeIdleDays` (0–365, 0 = off). Workspace
     `~/.cezar/config.json` `resources.worktreeIdleDaysDefault` seeds repos that set none (default 7).
     Resolved by `resolveWorktreeIdleDays` (`src/config.ts`).
   - Eligible: `isIdleReclaimable` (`runs/retention.ts`): status `review`, `waiting`, `done`,
     `failed` or `cancelled`; a materialized tree; not reclaimed; not pinned; no pending
     `autoResumeAt` or `monitoringWakeAt`. Also not live (`RunManager.isActive`: queued, starting,
     or an open or parked session) and not used by a running process (`worktreesInUse`).
   - Last activity: `lastActivityAt` is the latest of the record's stamps and the event log's mtime
     (`RunStore.eventsMtimeMs`).
   - Same reclaim as #483: the directory goes, the branch stays, `worktreeReclaimedAt` is stamped,
     and Continue restores the tree (`rematerializeReclaimedWorktree`). A tree with uncommitted
     work is never reclaimed (#2215).
   - Runs at boot, after terminal transitions (`scheduleRetention`), hourly
     (`RETENTION_SWEEP_MS`), and on "Reclaim now". All go through `enforceWorktreeRetention`
     (count, then age, then archived).
   - `review` runs keep their diff and draft-PR gate after reclaim: the diff comes from the kept
     branch, and the PR path restores the tree on demand.
2. **Archive frees disk.** Archiving a task, or "Archive finished", reclaims the task's tree via
   `RunManager.reclaimWorktreesOf` (after its terminals stop). The hourly sweep retries a tree that
   was still in use. Unarchive plus Continue restores it.
3. **Disk guard.** Thresholds in workspace `resources.diskGuard`:
   `{ minFreePercent: 10, minFreeGb: 5, maxWorktreesGb: 20 }`. Each 0 turns that trigger off.
   - The guard acts when free space on the worktrees volume is below the SMALLER of
     `minFreePercent`% and `minFreeGb`, or when task worktrees total more than `maxWorktreesGb`.
   - It reclaims the oldest idle-reclaimable trees first, across all projects, until back under
     the threshold.
   - If that is not enough, it shows a cockpit warning, an attention item and a notification:
     "Disk almost full — N GB in task worktrees".
   - It never blocks running tasks. Each check is one `statfs`; sizes are cached from a background
     `du` with a TTL.
4. **CLI `cez worktrees`.**
   - `list`: run, status, last activity, size, reclaimable.
   - `reclaim [--older-than 7d] [--all-inactive] [--dry-run]`.
   - `prune`: orphan trees plus `git worktree prune`.
   - `remove <runId>`: reclaims that run's tree (branch kept). It refuses active runs.
   - Uses the running server's API when one serves the project; otherwise it works on the project
     path directly, under the store's lock.

## API

- `GET /api/v1/worktrees`: rows gain `lastActivityAt`, the response gains `idleDays`, and
  `reclaimable` now means idle-reclaimable, not live and not in use.
- `POST /api/v1/worktrees/reclaim` body `{ olderThanDays?, allInactive?, runIds?, dryRun? }`. An
  empty body runs the configured retention. The response is `{ reclaimed, dryRun? }`.
- `GET/PUT /api/v1/workspace/config` `resources.worktreeIdleDaysDefault`, `resources.diskGuard`.
- `GET/PUT /api/v1/config` `worktreeIdleDays` (null clears it), `worktreeIdleDaysOwn`.
