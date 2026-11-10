# Execution plan — a stale `automation-poll.lock` no longer starves the workspace scheduler

Issue: [#983](https://github.com/open-mercato/cezar/issues/983)
Branch: `fix/automation-stale-poll-lock`
Engine: om-auto-create-pr (steps: 8, --loop: no)

## Goal

Kill the ten-minute, workspace-wide, completely silent automation outage that follows a cockpit
crash during a poll: reclaim a lock whose writer is dead, leave a log trace when a poll is skipped,
and never re-arm a failed check at a zero delay.

## Background — the four composing causes (from #983)

1. `ProjectAutomationScheduler.check()` acquires the lease **before** the `try`, so
   `throw new Error('automation polling lease is held by another process')` reaches neither
   `recordFailure` nor the `finally`. Nothing is logged, no state is written.
2. `WorkspaceAutomationScheduler.schedule()` arms the timer with
   `void next.fire().catch(() => undefined).finally(() => this.schedule())` at
   `Math.max(0, next.at - now)`. `next.at` is the automation's already-past `nextCheckAt`, so the
   delay is `0` and the rejection is swallowed — a tight loop.
3. Only `due[0]` runs per workspace tick. The throwing automation is always the earliest, so no
   other project's automations ever get a turn.
4. `AutomationStore.acquireLease()` reclaims a lock only on 10-minute `mtime` age. The lock file
   already records `{"pid":…,"startedAt":…}` but the pid is never consulted, so a crashed writer is
   indistinguishable from a live one for the full ten minutes.

## Scope

`packages/cezar/src/automations/` only — `store.ts` (the lease) and `scheduler.ts` (the
lease-skip path in `ProjectAutomationScheduler.check` and the reschedule path in
`WorkspaceAutomationScheduler.schedule`), plus their unit tests.

### Non-goals

- The poll cursor advance logic (`cursor`, `laterCursor`, `maxRecords`, the 120s overlap band,
  poll budget) — a concurrent change owns that (#982). Untouched here to avoid a conflict.
- Runners, `workflows/run.ts`, `server-install`, the web package.
- Cause 4's **full** per-project round-robin turn-taking. The starvation it describes is caused by
  a *failing* automation monopolising the single workspace slot; the Phase-3 retry floor pushes a
  failed item behind every healthy one, which removes the observed starvation without a second
  scheduling policy. A general round-robin across healthy projects is a behavior change to the
  "earliest due wins" contract and is deferred — recorded in the PR body.

## Implementation plan

### Phase 1 — reclaim a lock whose writer is gone

The lock already carries the writer's pid. `process.kill(pid, 0)` tells a crashed writer from a
live one, so the common case becomes instant instead of ten minutes. The `mtime` age check stays as
the fallback for a lock whose pid cannot be read (an empty or half-written file, a lock from a
container whose pid namespace we do not share).

1.1 Read the lock's pid in `acquireLease` and reclaim it when that process is not alive; keep the
    age check as the fallback, keep the reclaim recursion bounded, and treat `EPERM` (a live
    process owned by somebody else) and our own pid as alive.
1.2 Unit tests: a dead-pid lock is reclaimed immediately, a live-pid lock is not, a malformed lock
    still falls back to the age rule, and the real (uninjected) liveness probe agrees.

### Phase 2 — a poll that cannot take the lease leaves a trace

2.1 Move the lease acquisition inside `check()`'s `try` and treat lease contention as a **skip**,
    not a failure: append a `skipped` log record and push `nextCheckAt` out by the automation's
    interval, without touching `consecutiveFailures`/`backoffUntil`. This mirrors what
    `ScheduleRunner.launch` already does for the same condition. `check()` still rejects so the
    `POST /automations/:id/check` route keeps reporting the contention.
2.2 Unit tests: a contended lease writes a `skipped` record, advances `nextCheckAt`, and leaves the
    failure counters alone; the preview mode logs it without writing state.

### Phase 3 — never reschedule a failed fire at zero delay

3.1 Give each due item a stable key and a retry floor in `WorkspaceAutomationScheduler`: on
    rejection, remember `now + max(interval, 60s)` for that key and clamp the item's next `at` to
    it; clear the memo when the item next succeeds, and drop memos for items that no longer exist.
3.2 Unit tests: a check that rejects is re-armed with a non-zero delay (no spin), a second
    project's automation gets the slot while the failing one is backed off, and a later success
    clears the floor.

### Phase 4 — validate and ship

4.1 Run the full validation gate: `npm run typecheck`, `npm test`, `npm run test:unit`,
    `npm run build`, `npm run test:package`.
4.2 Refresh the PR body, apply labels, run `om-auto-review-pr --autofix`.

## Risks

- **pid reuse.** A recycled pid makes a dead writer look alive; the change then degrades to exactly
  today's behavior (reclaim after ten minutes), so it is never worse than the status quo.
- **Shared-directory pid namespaces.** A lock written inside a container and read outside it has a
  pid that means nothing here. Same degradation: `EPERM` and unknown pids count as alive, the age
  fallback still fires.
- **Conflict with #982.** Both changes touch `scheduler.ts`. This one stays out of the poll body
  (cursor/eligibility/state-write block) entirely.

## Validation note — the cezar task environment breaks the suite, not the change

Run inside a cezar task, `npm test` reports 10-13 failures with or without this change. Two causes,
both environmental: `TMPDIR` points at `.ai/cezar/tmp/<runId>` *inside the repository*, so every
"outside a git repository" test (`git.test.ts`, `git-worktree.test.ts`, `git-changes.test.ts`,
`health-forge.test.ts`, `route-parity.test.ts`) finds a repo where it expects none; and the run's
`CEZ_*` variables (notably `CEZ_TODOS_FILE`) are exactly what the zero-config prompt tests assert
are absent. The gate below was therefore run with `TMPDIR=/tmp` and the `CEZ_*` variables unset,
where the whole suite is green. The same run on unmodified `origin/main` sources produced an
identical failure set before that scrub, so none of it is attributable to this change.

## Progress

PR: #993

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reclaim a lock whose writer is gone

- [x] 1.1 Consult the lock's pid in `acquireLease`, with the age check as fallback — 73b04566
- [x] 1.2 Unit tests for dead pid, live pid, malformed lock, and the real liveness probe — 73b04566

### Phase 2: A poll that cannot take the lease leaves a trace

- [x] 2.1 Acquire the lease inside `check()`'s try and record contention as a `skipped` poll — 081d4a4f
- [x] 2.2 Unit tests for the skipped record, the advanced `nextCheckAt`, and untouched failure counters — 081d4a4f

### Phase 3: Never reschedule a failed fire at zero delay

- [x] 3.1 Per-item retry floor in `WorkspaceAutomationScheduler.schedule` — 2e4bff62
- [x] 3.2 Unit tests for the no-zero-delay invariant and the unblocked second project — 2e4bff62

### Phase 4: Validate and ship

- [x] 4.1 Full validation gate — all five commands exit 0 (see the PR body)
- [x] 4.2 PR body, labels, authoritative review pass — om-auto-review-pr: APPROVE, no blockers
