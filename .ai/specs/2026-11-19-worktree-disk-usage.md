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
   - Reclaimed runs keep their diff after reclaim: `/diff`, `/commits` and `/commit/:sha` read
     the kept branch without a checkout, and `/changes` says the tree was reclaimed. Only the PR
     path (the PR route and the `github.draft-pr` gate) restores the tree. It restores onto the
     kept branch only, never onto a fresh branch off the base after the branch was deleted.
     `POST /runs/:id/pr/adopt` finds an existing PR from the kept branch without a checkout, and
     archive's delayed reclaim skips a task unarchived in the meantime.
2. **Archive frees disk.** Archiving a task, or "Archive finished", reclaims the task's tree via
   `RunManager.reclaimWorktreesOf` (after its terminals stop). The hourly sweep retries a tree that
   was still in use. Unarchive plus Continue restores it.
3. **Disk guard.** Thresholds in workspace `resources.diskGuard`:
   `{ minFreePercent: 10, minFreeGb: 5, maxWorktreesGb: 20 }`. Each 0 turns that trigger off.
   - The guard acts when free space on the worktrees volume is below the SMALLER of
     `minFreePercent`% and `minFreeGb`, or when task worktrees total more than `maxWorktreesGb`.
   - It reclaims the oldest idle-reclaimable trees first, across every project this process has
     open, until back under the threshold. It never opens a closed project: building a context
     runs `recover()`, which would resume that project's interrupted tasks.
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

5. **Archived tasks are deleted after N days.**
   - Repo `archivedTaskDeleteDays`; workspace `resources.archivedTaskDeleteDaysDefault`. The default
     is 90, and 0 means never.
   - The clock starts at `archivedAt`. Older records fall back to `finishedAt`, then to their last
     activity (`runs/archived-cleanup.ts`).
   - Deletion removes the record and every per-task file (`RunStore.deleteRun`), the worktree and the
     branch.
   - The branch stays, and only the task is deleted, when the branch has an open PR (or `gh` cannot
     tell for a task that opened one), or has commits that are neither merged into the default
     branch nor pushed.
   - It never touches an unarchived, live, running, queued or pinned task, nor a tree with
     uncommitted work.
   - It runs with every retention pass (queued off the boot path) and the hourly sweep, and logs a summary. The 500-archived cap stays as
     the backstop.
   - CLI: `cez worktrees prune --archived-older-than 90d [--dry-run]`.
6. **Task files go with the task.** `deleteRun` and the run-cap prune remove the task's
   `artifacts/<id>` and its `dispatch/<root>` tree once no member remains. A startup sweep removes
   the leftovers of tasks already gone; it skips an index that did not load or is empty, and
   directories younger than an hour (`runs/task-files.ts`). The attachment library (#929) is never
   swept: it holds the user's own files (BACKWARD_COMPATIBILITY.md §3).
7. **Old cezar versions are pruned** (`self-update/versions-prune.ts`).
   - It keeps the running version plus the 2 most recently installed others. The setting is
     `versionRetention` in `~/.cezar/config.json`: default 3, and 0 turns the automatic prune off.
   - It runs at boot and after every update.
   - It never removes the current, running, leased or in-use version, a linked checkout, or anything
     while an install is staging.
   - `versions.backup-*` directories are removed only by `cez versions prune --backups`.

## API

- `GET /api/v1/worktrees`: rows gain `lastActivityAt`, the response gains `idleDays`, and
  `reclaimable` now means idle-reclaimable, not live and not in use.
- `POST /api/v1/worktrees/reclaim` body `{ olderThanDays?, allInactive?, runIds?, dryRun? }`. An
  empty body runs the configured retention. The response is `{ reclaimed, dryRun? }`.
- `GET/PUT /api/v1/workspace/config` `resources.worktreeIdleDaysDefault`, `resources.diskGuard`.
- `GET/PUT /api/v1/config` `worktreeIdleDays` (null clears it), `worktreeIdleDaysOwn`,
  `archivedTaskDeleteDays`, `archivedTaskDeleteDaysOwn`; workspace
  `resources.archivedTaskDeleteDaysDefault`.
- `POST /api/v1/runs/archived/delete-expired` body `{ olderThanDays?, dryRun? }`.
- `POST /api/v1/worktrees/prune`; `GET /api/v1/workspace/disk-guard`.
