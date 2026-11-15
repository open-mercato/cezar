# Idle-closed attention state ("closed · idle")

Tracking issue: #1933 · Precedent: #1290 (`awaitingAnswerSince`), #690, #992

## 📝 TLDR

**Who it affects:** a user who stops replying to a task because they no longer need it.

**Today:** about 15 minutes later the task shows a **red "failed"** dot and *"Session failed — the session closed after inactivity…"*. Nothing failed. The idle timer only freed the agent process.

**Proposed:** such a task settles to a distinct **orange "closed · idle"** state:
- not red, and not counted as a failure;
- not under "Needs you";
- still resumable with Continue.

## 📝 Problem Statement

A markerless turn end (no `CEZ:DONE` / `CEZ:ASK` / `CEZ:MONITORING`) parks the run as `waiting` and arms the idle timer (`idleTimeoutMinutes`, default 15, `workspace/config.ts:85`). When the timer fires and the review gate does not apply, the run settles `failed` with `inactivityFailureMessage()`.

The cockpit then reads it like any other failure:
- `deriveAttention` puts it in bucket `error`, tone `danger` (`web/src/lib/attention.ts:147`);
- the thread footer says "Session failed" (`thread-state.ts:191`);
- `failureKind` counts it as `'timeout'` (`runs/failure-kind.ts:13`);
- the dashboards count it as failed.

#1290 chose `failed` deliberately: `done` would claim success, and keeping these runs under "Needs you" would bring back #690 (informational turns piling up forever). The missing piece is a third presentation, **closed because nobody replied**. The reporter on #1933 confirms the user-facing harm: the red status reads as an error when the user simply stopped caring.

## 📝 Proposed Solution

Follow the #1290 pattern exactly. The record stays `status: 'failed'`, so there is no new `RunStatus`, and Continue, retention and every status consumer keep working. An optional marker field `idleClosedAt` tells each surface why the run failed. The cockpit derives a new attention rung from it, ahead of the generic `failed` rung.

**Alternatives rejected:**
- **A new `RunStatus` such as `'idle'`.** It breaks every exhaustive status switch, the webhook payloads and older cockpits. Protected by `BACKWARD_COMPATIBILITY.md`.
- **Reusing `completionReason`.** The store clears it whenever the status is not `done` (`store.ts:1000`), and it is a webhook enum.
- **Matching on the error string.** It is brittle. The triage comment on #1933 rules it out.
- **Grey (`neutral`).** Grey already means cancelled. The reporter chose orange.

## 📝 Architecture

### Engine (`packages/cezar/src/workflows/run.ts`)

There are three idle-settle sites. The triage comment on #1933 identified them, and they were re-verified on `0ff3291b`:

1. **Continuation** (`:5961-5973`). The `idleClosedFails` branch calls `publishRunFailure` directly. Add `idleClosedAt: failedAt`.
2. **First run** (graph walk `:6685-6688` → `runError` `:6363` → generic `else if (runError)` `:6423-6431`). That branch is shared with real crashes and runner timeouts. Stamp `idleClosedAt` there **only when `state.idleClosed === true`**, never by matching `runError` against the message. `state.idleClosed` is set by the timer (`:9305`) and cleared only by explicit user action (`:5034`, `:5078`, `:5091`, `:5107`, `:8811`), so it is still accurate at settlement.
3. **The dead `else if (idleFailed)` branch** (`:6435`). `idleFailed` is initialised to `false` at `:6322` and never assigned. **Delete it**: path 2 now carries the case, and an unreachable branch is where a future fix would stamp the wrong site.

Only the `!askPark` case is stamped. An unanswered `CEZ:ASK` or a monitoring hand-off keeps `awaitingAnswerSince` and its yellow "needs you" (#1290). Idle closes that go to the review gate keep `review`.

### Store (`packages/cezar/src/runs/store.ts`)

`idleClosedAt` follows the `awaitingAnswerSince` invariant:
- it exists only while `status === 'failed'` (`:988`, `:1508`);
- it is cleared on resume (`:670`).

Continue, Finish, cancel and archive therefore retire it with no extra code.
Finish on an idle-closed run is **Mark as done** (#2053): `RunManager.finish()` settles it `done`
(`completionReason: 'accepted'`), marks it read, and rewrites the idle-closing step to `done`, so the
rail does not turn red once the marker is gone. Real failures still answer 409.

### Cockpit (`packages/web`)

`deriveAttention` gets a new rung after `isAwaitingAnswer` and before `failed`:

```ts
{ bucket: 'none', tone: 'idle', pulse: false, label: 'closed · idle' }
```

- Bucket `none` keeps the run out of "Needs you", the error list and notifications.
- `StatusDot` gets `idle: 'bg-conflict'`, the existing orange token (orange-400 in dark mode, orange-700 in light), which already exists to be visibly different from amber.

## 📝 Data Model

Add `idleClosedAt?: string` (ISO datetime) to the run record. Exactly like `awaitingAnswerSince`, it is:
- additive and optional;
- `.optional().catch(undefined)` in the store schema, so a bad value drops only the field;
- absent on old records, which keep rendering red.

That last point is acceptable: there is no backfill, because old idle closes cannot be distinguished reliably without matching the message string.

## 📝 API Contracts

`packages/contract/src/runs.ts`: add `idleClosedAt: z.string().optional()` beside `awaitingAnswerSince` on both the run record (`:318`) and the cross-project task row (`:509`). Also add it to the dashboard cost row (`contract/src/dashboard-costs.ts`).

Every server row builder that spreads `awaitingAnswerSince` spreads `idleClosedAt` the same conditional way (AGENTS.md, HTTP API: never `key: maybeUndefined`):
- `server/server.ts:8135`
- `workspace/dashboard-costs.ts:57`
- `workspace/dashboard-insights.ts:69`

`contract-parity*.test.ts` must stay green in both directions.

## 📝 UI/UX

| Surface | Today | Proposed |
|---|---|---|
| Status dot / pill (sidebar, tasks overview, palette, run header, dashboard rows) | red "failed" | orange "closed · idle", still (no pulse) |
| "Needs you" list and counts | absent | absent (unchanged) |
| Error bucket and failure notification | present | absent |
| Thread footer | red "Session failed — the session closed after inactivity…" | neutral "Closed after inactivity — Continue to pick it up" |
| Continue | available | available (unchanged) |
| Dashboard failed counts (`dashboard-insights.ts:167,251`, `dashboard-overview.ts:34`) | counted | excluded from **failed** counts only |

The dot carries `aria-label="closed · idle"`, as every attention dot does. Colour is never the only signal.

**Deliberately unchanged.** An idle-closed run is a *finished outcome*, not a gate. So it stays out of every place `awaitingAnswerSince` treats a run as still open, and needs no edit in any of these:
- **Bulk "Archive finished":** it sweeps the run (`store.ts:1668-1676`, `server.ts:4968`, `web/src/lib/tasks-table.ts:113`).
- **Unread title weight:** the run becomes unread like any finished run (`store.ts:1750-1756`, `web/src/lib/read-state.ts`). The orange dot is the status signal, and the unread weight stays a separate channel.
- **Recent-outcome lists:** `workspace/dashboard.ts:444` keeps listing it. Those rows paint through `deriveAttention`, so it shows orange.
- **"Needs you" predicates and sort weight:** it stays out of all of them (`dashboard.ts:70`, `dashboard-overview.ts:28`, `dashboard-insights.ts:142`, `web/src/lib/task-groups.ts:56`, `onboarding.ts:268`).
- **The `threadFooter(…, isAwaitingAnswer)` call** (`routes/task-thread/task-thread.tsx:202`): it keeps its argument. The footer reads `idleClosedAt` from the run it already receives.
- **The dispatch-child hold** (`run.ts:3445`): not applicable. An idle-closed child is an ordinary failed child for its parent.

## 📝 Edge Cases & Failure Scenarios

- **Finish races the idle close.** Finish clears `state.idleClosed` first (`:5091`, `:5107`), so the run settles `done` and is not stamped. The existing #1527 tests cover this.
- **A crash while `state.idleClosed` is set.** The session ended through the timer, so `runError` here is the inactivity failure. A runner crash in the same window would be mislabelled idle. That's acceptable, because the user-visible action (Continue) is the same.
- **Unanswered `CEZ:ASK` that idle-closes.** The `askPark === 'waiting'` branch runs first and stays yellow. A guard test pins this.
- **Review gate applies.** `idleClosedFails` returns false, the run stays `review`, and it is not stamped.
- **Restart recovery.** An interrupted `waiting` run is settled by the recovery path (`:2552`), not the idle timer, so it is not stamped. Out of scope.
- **Old cockpit, new record.** The field is ignored and the run shows red, as today.

## 📝 Risks & Impact Review

- **`risk-high` by SDLC.md's surface list** (the `.ai/cezar/` state format and the HTTP contract), although the change is purely additive. Rollback means dropping the field: old readers ignore it and new readers fall back to red.
- **Telemetry:** `task_failed` volume drops by the number of idle closes. That is intended, but note it in the CHANGELOG so the dashboard step is not read as a regression. `failureKind` must return `undefined` for a run carrying `idleClosedAt`. It keys on the message today, so the call site that has the run record must short-circuit first.
- **`BACKWARD_COMPATIBILITY.md`:** add one line beside the `awaitingAnswerSince` note (around `:250`).
- **Product direction:** reverses part of #1290's presentation (not its semantics). The #1290 author confirmed on #1933 ("defaults are fine").

## 📋 Phasing

There is a single phase. The engine stamp without the UI rung would change nothing visible, and the UI rung without the stamp would never match.

## 📋 Implementation Plan

### Phase 1: idle-closed state end to end

1. **Contract and store.**
   - Add `idleClosedAt` to `contract/src/runs.ts` (run record and task row) and `contract/src/dashboard-costs.ts`.
   - In `runs/store.ts`, add it to the schema and apply the failed-only invariant and resume clear next to every `awaitingAnswerSince` site (`:321`, `:670`, `:988`, `:1508`).
   - Tests: a store round-trip, a bad value drops only the field, and a non-failed status clears it.
2. **Engine stamp.**
   - `run.ts`: stamp at `:5966-5972` (Continue).
   - Stamp at the `else if (runError)` branch when `state.idleClosed === true && askPark !== 'waiting'`.
   - Delete the dead `idleFailed` variable and branch.
   - Tests in `workflows/run*.test.ts` with fake timers:
     - a **first-run** idle close stamps `idleClosedAt`;
     - a **Continue** idle close stamps it;
     - an unanswered `CEZ:ASK` idle close does **not** (it keeps `awaitingAnswerSince`);
     - a real runner error does **not**.
   - Prove the first-run test fails without the fix (AGENTS.md: stash the source, confirm red).
3. **Server rows.** Spread the field conditionally in `server.ts:8135`, `dashboard-costs.ts:57` and `dashboard-insights.ts:69`. Exclude it from the failed counts and active filters in `dashboard-insights.ts` and `dashboard-overview.ts`. Contract-parity tests stay green.
4. **Cockpit.**
   - Add the `idle` tone (`components/status-dot.tsx`, `AttentionTone` in `lib/attention.ts`).
   - Add the attention rung and an `isIdleClosed` helper.
   - Change the footer copy and tone (`routes/task-thread/thread-state.ts:191`).
   - Carry it through `api/dashboard-truth.ts`, `routes/dashboard/rows.tsx`, `costs.tsx` and `components/command-palette.tsx`.
   - Tests:
     - `attention.test.ts`: the idle rung, ASK still yellow, a plain failure still red;
     - `task-thread.test.tsx`: update the existing inactivity footer cases;
     - `status-dot` renders `bg-conflict`.
5. **Telemetry and docs.**
   - `failureKind` skips runs carrying `idleClosedAt`, with a test.
   - Add the `BACKWARD_COMPATIBILITY.md` line.
   - Add a CHANGELOG entry.
   - Update the task-states feature page in `docs/site` if it lists status colours.

## Resolved assumptions (autonomous defaults)

| # | Question | Answer | Rationale |
|---|---|---|---|
| A1 | New status, or a marker field? | Optional field `idleClosedAt` on a `failed` record | Mirrors #1290. No breaking change to `RunStatus`. |
| A2 | Colour and label | Orange `bg-conflict`, "closed · idle", no pulse | Confirmed by the reporter and the triage on #1933. Grey means cancelled. |
| A3 | Should unanswered `CEZ:ASK` also go orange after a grace period? | No, deferred | Out of scope per #1933. #1290 keeps them under "Needs you" deliberately. |
| A4 | Fate of the dead `idleFailed` branch | Delete it | An unreachable branch invites stamping the wrong site. |
| A5 | Backfill old idle-closed records? | No | Would require matching the message string. Old records keep rendering red. |
| A6 | Exclude from failure telemetry and dashboard counts? | Yes | It is not a failure. Mirrors `awaitingAnswerSince`. |
| A7 | Treat it as a gate (skipped by Archive finished, never unread), like `awaitingAnswerSince`? | No, it is an ordinary finished outcome | The user walked away. Sweeping it is exactly what they want, and #690 forbids it lingering. |
