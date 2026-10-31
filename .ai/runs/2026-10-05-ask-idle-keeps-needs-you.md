# Keep an unanswered CEZ:ASK under "needs you" after the idle close

Goal: a task that ended its turn on `CEZ:ASK` and was never answered keeps reading as "needs you" after the inactivity timer (or a crash or a restart) closes its session. It must not move to "done" (today on `main`) or to a red "failed" (PR #1245).

Builds on PR #1245 (`cez/e041ea2c`), which already stops idle closure from settling runs as `done` and persists `askParked` for final interactive asks. This branch merges current `main` (including #1282) on top of it.

## Investigation

- `armIdleTimer` (`packages/cezar/src/workflows/run.ts`) ends the session after `resources.idleTimeoutMinutes` (default 15). On `main` the generic session-end path then calls `settleSuccess`, so the run becomes `done` and logs `run finished` (the user's screenshot, and issue #689).
- #1245 settles an unanswered ASK as `failed`. The cockpit buckets `failed` under Recent with a red badge (`bucketOf`, `deriveAttention`), so the task still drops out of "Needs you".
- The idle close exists for the opposite problem: markerless "informational" waits that sit in "needs you" forever while holding a live agent process (issue #690, spec `2026-07-24-long-running-waiting-sessions.md`). That has to keep working.
- Keeping the record at `waiting` with no live session is not viable. The web treats `waiting` as "session open" (`task-thread.tsx`), `continueRun` refuses `waiting`, and slot accounting assumes a live process.
- Precedent: `autoResumeAt` already marks a `failed` run that the attention layer reads differently (scheduled, not failed).
- Found while tracing: #1282 retires a stale question park only in `runAgentStep`'s turn-end. #1245 also sets the park in `runContinuation`, so a continuation that asked and then woke itself without asking again kept a stale park. With this change that would be a false "needs you".

## Approach

- New optional `RunRecord.awaitingAnswerSince` (ISO), set only on a `failed` run whose session ended while a `CEZ:ASK` was unanswered: both settlement branches (`execute`, `runContinuation`), `recover()`, and `reconcileLoadedRun` for non-recovering readers.
- Store invariant: only `failed` carries it. `updateRun`/`reconcileLoadedRun` retire it on any other status (Continue → `running` clears it), archive retires it, and `markAllRead` skips it.
- Cockpit: `deriveAttention` → `waiting`/"needs you"; `bucketOf` → Needs you; `listCounts` waiting count; sort rank with waiting; not unread and not dimmed history; palette + runs-index carry it.
- Dashboard: questions/needs-you groups and overview count it; insights treat it as active, not a failure.
- `runContinuation` turn-end retires a stale question park (twin of #1282).
- Markerless waits keep #1245's `failed` fallback, so they do not come back as permanent "needs you".

Non-goals: no new run status, no LLM classifier (#689's broader idea), no change to the idle timeout or monitoring, no acknowledgement flow (#690).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Engine and store

- [x] 1.1 Persist `awaitingAnswerSince` at every unanswered-ASK settlement and enforce the failed-only invariant in the store.
- [x] 1.2 Retire a stale question park on continuation turns.

### Phase 2: Attention surfaces

- [x] 2.1 Read the field in cockpit attention, bucketing, counts, ordering, read-state and palette, plus the runs index and contract.
- [x] 2.2 Count it as a question in the dashboard snapshot, overview and insights.

### Phase 3: Verification

- [x] 3.1 Regression tests: engine (final ASK, continuation ASK, self-woken continuation, recover), store, web, dashboard, runs index; red proof for the continuation park.
- [x] 3.2 Full validation gate and PR.

## Risks

- `failed` status with a "needs you" reading: consumers that branch on raw status (e.g. third-party API clients) still see `failed`. That is honest (no process is running). The field is additive and documented in `BACKWARD_COMPATIBILITY.md`.
- Stacked on #1245: merge #1245 first, or merge this PR instead of it.

### Phase 4: Review fixes

- [x] 4.1 Dashboard queue/overview keep awaiting rows actionable; live overlay and cost rows carry the field; crash/timeout stamps; thread footer; "Archive finished" leaves open questions; stable cold-read stamp.

## Follow-ups (not in this PR)

- Codex's native `requestUserInput` question parks `waiting` without `askPark`, so an idle close or restart still does not keep it under "needs you".
- An awaiting run can only leave "needs you" by being answered or archived; Finish is not offered on a closed session.

