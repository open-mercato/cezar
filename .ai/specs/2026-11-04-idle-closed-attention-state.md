# Idle-closed attention state ("closed · idle")

Tracking issue: #1933 · Precedent: #1290 (`awaitingAnswerSince`), #690, #992

**Status: shipped in #1935 (0.19.0).** This spec describes what shipped. § Deviations from the spec lists where that differs from the first draft.

## 📝 TLDR

**Who it affects:** a user who stops replying to a task because they no longer need it.

**Today:** about 15 minutes later the task shows a **red "failed"** dot and *"Session failed — the session closed after inactivity…"*. Nothing failed. The idle timer only freed the agent process.

**Proposed:** such a task settles to a distinct **orange "closed · idle"** state:
- not red, and not counted as a failure;
- not under "Needs you";
- still resumable with Continue.

## 📝 Problem Statement

A markerless turn end (no `CEZ:DONE` / `CEZ:ASK` / `CEZ:MONITORING`) parks the run as `waiting` and arms the idle timer (`armIdleTimer` in `run.ts`; `idleTimeoutMinutes`, default `DEFAULT_IDLE_TIMEOUT_MINUTES` = 15 in `workspace/config.ts`). When the timer fires and the review gate does not apply, the run settles `failed` with `inactivityFailureMessage()`.

The cockpit then reads it like any other failure:
- `deriveAttention` puts it in bucket `error`, tone `danger` (its `failed` rung, `web/src/lib/attention.ts`);
- the thread footer says "Session failed" (`threadFooter`, `thread-state.ts`);
- `failureKind` counts it as `'timeout'` (`TIMEOUT_RE`, `runs/failure-kind.ts`);
- the dashboards count it as failed.

#1290 chose `failed` deliberately: `done` would claim success, and keeping these runs under "Needs you" would bring back #690 (informational turns piling up forever). The missing piece is a third presentation, **closed because nobody replied**. The reporter on #1933 confirms the user-facing harm: the red status reads as an error when the user simply stopped caring.

## 📝 Proposed Solution

Follow the #1290 pattern exactly. The record stays `status: 'failed'`, so there is no new `RunStatus`, and Continue, retention and every status consumer keep working. An optional marker field `idleClosedAt` tells each surface why the run failed. The cockpit derives a new attention rung from it, ahead of the generic `failed` rung.

**Alternatives rejected:**
- **A new `RunStatus` such as `'idle'`.** It breaks every exhaustive status switch, the webhook payloads and older cockpits. Protected by `BACKWARD_COMPATIBILITY.md`.
- **Reusing `completionReason`.** The store clears it whenever the status is not `done` (`reconcileLoadedRun`, `store.ts`), and it is a webhook enum.
- **Matching on the error string.** It is brittle. The triage comment on #1933 rules it out.
- **Grey (`neutral`).** Grey already means cancelled. The reporter chose orange.

## 📝 Architecture

### Engine (`packages/cezar/src/workflows/run.ts`)

The idle timer (`armIdleTimer`) sets `state.idleClosed = true` and ends the session. `idleClosedFails` decides whether that close settles as a failure: it does, unless the review gate applies. There are two stamp sites, and neither matches the error text:

1. **Continuation.** In `runContinuation`, the `idleClosedFails` branch calls `publishRunFailure` directly with `idleClosedAt: failedAt`.
2. **First run.** After an agent node's turn, `executeGraph` checks `idleClosedFails`. When it holds, the walk fails on the idle close itself: the step finishes `failed` with `{ idleClosed: true }`, **`state.idleFailed = true`** is set, and the inactivity message comes back as `runError`. `execute`'s `else if (runError)` settle is shared with real crashes and runner timeouts. It stamps `idleClosedAt` only when `state.idleFailed === true && askPark !== 'waiting'`.

**Why the gate is `idleFailed`, not `idleClosed`.** `state.idleClosed` is the timer's flag. Only explicit user action clears it (a message through `deliverMessage`, `finish`, `land`), so it survives a review-gate pass. If the review gate keeps the node and the walk later fails for a real reason (a missing verdict, a check), the timer flag is still set and would stamp that failure idle. `state.idleFailed` is set only where the walk fails *because of* the idle close, so at settlement it is true only when `runError` is that failure. The #1935 review pass caught the stale-flag stamp (`389bbf4d`).

**`idleFailed` is the real signal: do not remove it.** At `0ff3291b`, `execute` had a local `let idleFailed = false` that was never assigned and an unreachable `else if (idleFailed)` branch. #1935 deleted that dead local and branch, then made `idleFailed` an `ActiveRun` field that `executeGraph` sets.

Both stamp sites append the lifecycle note `IDLE_CLOSED_LIFECYCLE` ("run closed after inactivity — nobody replied; Continue to resume it") instead of `run failed — …`.

Only the `!askPark` case is stamped. An unanswered `CEZ:ASK` or a monitoring hand-off keeps `awaitingAnswerSince` and its yellow "needs you" (#1290). Idle closes that go to the review gate keep `review`.

### Store (`packages/cezar/src/runs/store.ts`)

`idleClosedAt` follows the `awaitingAnswerSince` invariant, with one exception:
- it exists only while `status === 'failed'`: `reconcileLoadedRun` drops it on load, and `updateRun` drops it from any patch to another status;
- Continue (`running`/`queued`), Finish and cancel therefore retire it with no extra code;
- **archive keeps it.** `setArchived` clears `awaitingAnswerSince` through `clearAwaitingAnswer`, because archiving resigns from a question. An idle close is an ordinary finished outcome (A7), and clearing its marker would repaint an archived idle close red. `BACKWARD_COMPATIBILITY.md` records the same rule.

### Cockpit (`packages/web`)

`deriveAttention` gets a new rung after `isAwaitingAnswer` and before `failed`:

```ts
{ bucket: 'none', tone: 'idle', pulse: false, label: 'closed · idle' }
```

- `isIdleClosed(run)` (`lib/attention.ts`) is true for a `failed` run that carries `idleClosedAt` and is not awaiting an answer.
- Bucket `none` keeps the run out of "Needs you", the error list and notifications.
- `StatusDot` gets `idle: 'bg-conflict'`, the existing orange token (orange-400 in dark mode, orange-700 in light), which already exists to be visibly different from amber.
- `threadFooter` takes a new `idleClosed` argument; `ThreadView` passes `isIdleClosed(run)`.
- The transcript reducer (`thread-state.ts`) skips a `step-end` that carries `idleClosed: true`, so the thread shows no red "step failed" line. The two lifecycle notes say what happened.
- The dashboard feed kicker (`routes/dashboard/feed.tsx`) says "Closed after inactivity" instead of "Failed".

## 📝 Data Model

Add `idleClosedAt?: string` (ISO datetime) to the run record. Exactly like `awaitingAnswerSince`, it is:
- additive and optional;
- `.optional().catch(undefined)` in the store schema, so a bad value drops only the field;
- absent on old records, which keep rendering red.

That last point is acceptable: there is no backfill, because old idle closes cannot be distinguished reliably without matching the message string.

## 📝 API Contracts

`packages/contract/src/runs.ts`: add `idleClosedAt: z.string().optional()` beside `awaitingAnswerSince` on both `runRecordSchema` and the cross-project task row `runIndexEntrySchema`. Also add it to `dashboardCostTaskSchema` (`contract/src/dashboard-costs.ts`).

Every server row builder that spreads `awaitingAnswerSince` spreads `idleClosedAt` the same conditional way (AGENTS.md, HTTP API: never `key: maybeUndefined`):
- `runIndexEntry` in `server/server.ts`
- `projectCostTask` in `workspace/dashboard-costs.ts`
- `projectInsightRow` in `workspace/dashboard-insights.ts`

`contract-parity*.test.ts` must stay green in both directions.

## 📝 UI/UX

| Surface | Today | Proposed |
|---|---|---|
| Status dot / pill (sidebar, tasks overview, palette, run header, dashboard rows) | red "failed" | orange "closed · idle", still (no pulse) |
| "Needs you" list and counts | absent | absent (unchanged) |
| Error bucket and failure notification | present | absent |
| Thread footer | red "Session failed — the session closed after inactivity…" | dim "Closed after inactivity — Continue to pick it up" |
| Thread transcript | red "step failed" line | no step-failed line; dim "session closed after Nm of inactivity" and "run closed after inactivity — nobody replied; Continue to resume it" |
| Dashboard feed kicker | "Failed" | "Closed after inactivity" |
| Step rail | red dot | red dot (unchanged; follow-up) |
| Continue | available | available (unchanged) |
| Dashboard counts (`buildDashboardInsights`, `buildDashboardOverview`) | counted as failed | excluded from **failed** counts, and from Insights' `finished` so done + failed = finished |

The dot carries `aria-label="closed · idle"`, as every attention dot does. Colour is never the only signal.

**Follow-up:** the step rail (`routes/task-thread/step-rail.tsx`) still paints the idle-closed step with the red `failed` dot, because the step record is `failed`.

**Deliberately unchanged.** An idle-closed run is a *finished outcome*, not a gate. So it stays out of every place `awaitingAnswerSince` treats a run as still open, and needs no edit in any of these:
- **Bulk "Archive finished":** it sweeps the run (`archiveFinished` in `store.ts`, the archive route's `retiresQuestion` check in `server.ts`, `finishedRunCount` in `web/src/lib/tasks-table.ts`).
- **Unread title weight:** the run becomes unread like any finished run (`markAllRead` in `store.ts`, `web/src/lib/read-state.ts`). The orange dot is the status signal, and the unread weight stays a separate channel.
- **Recent-outcome lists:** the dashboard `feed` (`workspace/dashboard.ts`) keeps listing it. Those rows paint through `deriveAttention`, so it shows orange.
- **"Needs you" predicates and sort weight:** it stays out of all of them (`isQuestion` in `dashboard.ts`, the `needs-you` group in `buildDashboardOverview`, `isActive` in `dashboard-insights.ts`, `statusWeight` in `web/src/lib/task-groups.ts`, `welcomeBackSentence` in `web/src/lib/onboarding.ts`).
- **The dispatch-child hold** (`reportSettledChildToParent` in `run.ts`): not applicable. An idle-closed child is an ordinary failed child for its parent.

## 📝 Edge Cases & Failure Scenarios

- **Finish races the idle close.** `finish` clears `state.idleClosed` first, so the run settles `done` and is not stamped. The existing #1527 tests cover this.
- **A crash or runner timeout while `state.idleClosed` is set.** Handled. Only the idle-close branch in `executeGraph` sets `state.idleFailed`, so any other `runError` settles as an ordinary red failure.
- **A real failure after a review-gate pass.** The review gate keeps the node, `state.idleClosed` stays set, and the walk later fails for a real reason (a missing verdict, a check). It is not stamped, for the same reason. A regression test in `run.test.ts` pins this.
- **Unanswered `CEZ:ASK` that idle-closes.** The `askPark === 'waiting'` branch runs first and stays yellow. A guard test pins this.
- **Review gate applies.** `idleClosedFails` returns false, the run stays `review`, and it is not stamped.
- **Restart recovery.** `recover` settles an interrupted `waiting` run, not the idle timer, so it is not stamped. Out of scope.
- **Old cockpit, new record.** The field is ignored and the run shows red, as today.

## 📝 Risks & Impact Review

- **`risk-high` by SDLC.md's surface list** (the `.ai/cezar/` state format and the HTTP contract), although the change is purely additive. Rollback means dropping the field: old readers ignore it and new readers fall back to red.
- **Telemetry:** `task_failed` volume drops by the number of idle closes. That is intended. `failureKind` still keys on the message, so its call site short-circuits first: `updateRun` skips `task_failed` for a `failed` transition that carries `idleClosedAt`. The drop is recorded in the #1935 PR body (§ Scope). The 0.19.0 CHANGELOG entry lists the feature but not the drop.
- **`BACKWARD_COMPATIBILITY.md`:** one line beside the `awaitingAnswerSince` note in the `runs.json` section.
- **Product direction:** reverses part of #1290's presentation (not its semantics). The #1290 author confirmed on #1933 ("defaults are fine").

## 📋 Phasing

There is a single phase. The engine stamp without the UI rung would change nothing visible, and the UI rung without the stamp would never match.

## 📋 Implementation Plan

### Phase 1: idle-closed state end to end

1. **Contract and store.**
   - Add `idleClosedAt` to `runRecordSchema` and `runIndexEntrySchema` (`contract/src/runs.ts`) and to `dashboardCostTaskSchema` (`contract/src/dashboard-costs.ts`).
   - In `runs/store.ts`, add it to the schema and apply the failed-only invariant next to `awaitingAnswerSince` in `reconcileLoadedRun` and `updateRun`. Archive (`clearAwaitingAnswer`) keeps it.
   - Tests: a store round-trip, a bad value drops only the field, and a non-failed status clears it.
2. **Engine stamp.**
   - `run.ts`: stamp in `runContinuation`'s `idleClosedFails` branch (Continue).
   - In `executeGraph`'s idle-close branch, set `state.idleFailed = true` and flag the step-end `{ idleClosed: true }`.
   - Stamp in `execute`'s `else if (runError)` branch when `state.idleFailed === true && askPark !== 'waiting'`.
   - Delete `execute`'s dead `idleFailed` local and its `else if (idleFailed)` branch.
   - Tests in `workflows/run*.test.ts` with fake timers:
     - a **first-run** idle close stamps `idleClosedAt`;
     - a **Continue** idle close stamps it;
     - an unanswered `CEZ:ASK` idle close does **not** (it keeps `awaitingAnswerSince`);
     - a real runner error does **not**;
     - a real failure after a review-gate pass does **not**, although the timer flag is still set.
   - Prove the first-run and stale-flag tests fail without the fix (AGENTS.md: stash the source, confirm red).
3. **Server rows.** Spread the field conditionally in `runIndexEntry` (`server.ts`), `projectCostTask` and `projectInsightRow`. In `buildDashboardInsights` and `buildDashboardOverview`, exclude it from the failed counts and Insights' `finished`, and keep it out of the active filters. Contract-parity tests stay green.
4. **Cockpit.**
   - Add the `idle` tone (`components/status-dot.tsx`, `AttentionTone` in `lib/attention.ts`).
   - Add the attention rung and an `isIdleClosed` helper.
   - Change the footer copy and tone: `threadFooter` takes an `idleClosed` argument, and `ThreadView` passes `isIdleClosed(run)`.
   - Skip the idle `step-end` in the transcript reducer, and label the dashboard feed kicker.
   - Carry it through `api/dashboard-truth.ts`, `routes/dashboard/rows.tsx`, `costs.tsx` and `components/command-palette.tsx`.
   - Tests:
     - `attention.test.ts`: the idle rung, ASK still yellow, a plain failure still red;
     - `task-thread.test.tsx`: update the existing inactivity footer cases;
     - the transcript reducer drops the idle step-end's red line;
     - `status-dot` renders `bg-conflict`.
5. **Telemetry and docs.**
   - `updateRun` skips `task_failed` for a run carrying `idleClosedAt`, with a test.
   - Add the `BACKWARD_COMPATIBILITY.md` line.
   - Add the closed · idle paragraph to the waiting-timeout feature page (`docs/site/content/docs/03-features/tasks-and-sessions/waiting-timeout.mdx`).

## 📋 Deviations from the spec

#1935 differs from the first draft of this spec (`1fe31c80`) in these places. The sections above already describe what shipped.

- **Engine gate.** The first-run stamp keys on `state.idleFailed`, not `state.idleClosed`. The timer flag survives a review-gate pass, so the draft's gate would stamp a later, real failure (`389bbf4d`).
- **`idleFailed` kept.** The draft (A4) deleted it as dead. #1935 removed only the dead local and branch, and `idleFailed` is now the `ActiveRun` field the gate reads.
- **Crash while the timer flag is set.** The draft accepted labelling it idle. The same gate now settles it red.
- **Archive keeps the marker.** The draft had archive retire it: its "resume" clear pointed at `clearAwaitingAnswer`, which is the archive path. That would repaint an archived idle close red, against A7.
- **Insights `finished`.** Idle closes leave `finished` as well as `failed`, so done + failed still equals finished.
- **Thread.** `threadFooter` gained an `idleClosed` argument, where the draft expected it to read the run. The idle step-end carries `idleClosed: true` so the thread skips the red "step failed" line, and the dashboard feed kicker says "Closed after inactivity" (`c6e0ca4f`).
- **CHANGELOG.** No hand-written entry. `CHANGELOG.md` had no `# Unreleased` section then, and adding one would have replaced the generated release notes. The 0.19.0 entry lists #1935 and this spec (#1934). The `task_failed` drop is recorded in the #1935 PR body.

**Follow-up:** the step rail still shows a red dot for the idle-closed step (§ UI/UX).

## Resolved assumptions (autonomous defaults)

| # | Question | Answer | Rationale |
|---|---|---|---|
| A1 | New status, or a marker field? | Optional field `idleClosedAt` on a `failed` record | Mirrors #1290. No breaking change to `RunStatus`. |
| A2 | Colour and label | Orange `bg-conflict`, "closed · idle", no pulse | Confirmed by the reporter and the triage on #1933. Grey means cancelled. |
| A3 | Should unanswered `CEZ:ASK` also go orange after a grace period? | No, deferred | Out of scope per #1933. #1290 keeps them under "Needs you" deliberately. |
| A4 | Fate of the dead `idleFailed` branch | Delete the dead local and branch; keep `idleFailed` as the `ActiveRun` gate | The dead branch invited stamping the wrong site. `idleFailed` now carries the first-run stamp (§ Engine); removing it brings back the stale-flag bug. |
| A5 | Backfill old idle-closed records? | No | Would require matching the message string. Old records keep rendering red. |
| A6 | Exclude from failure telemetry and dashboard counts? | Yes | It is not a failure. Mirrors `awaitingAnswerSince`. |
| A7 | Treat it as a gate (skipped by Archive finished, never unread), like `awaitingAnswerSince`? | No, it is an ordinary finished outcome; archive keeps the marker | The user walked away. Sweeping it is exactly what they want, and #690 forbids it lingering. Clearing the marker on archive would repaint the run red. |
