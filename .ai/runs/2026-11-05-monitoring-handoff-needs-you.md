# Execution plan — monitoring hand-offs are not unanswered questions (#1945)

## Goal

A monitoring hand-off (wake-up cap or park-mode liveness bound) that the idle timer, a crash or a
restart closes must no longer settle as `failed` + `awaitingAnswerSince`, which every "needs you"
reader treats as a pending question. It carries its own durable reason and owner instead.

## Scope

- `packages/cezar`: `RunRecord.monitorHandoff` (optional, `{ reason, owner, since }`), set by
  `parkMonitorAsWaiting`; `settleUnansweredPark`, the two `runError` branches, `recover()` and
  `reconcileLoadedRun` stop stamping `awaitingAnswerSince` for it and write a reason/owner error.
  `updateRun`/`reconcileLoadedRun` retire the field off `waiting`/`failed`.
- `packages/contract`: the field on the run schema and the runs-index row.
- `packages/web`: `deriveAttention` labels (`monitoring paused` / `waiting on parent` /
  `monitoring stopped`), the thread footer for a settled hand-off.
- `BACKWARD_COMPATIBILITY.md`: the additive field.

## Non-goals

- No change to the wake-up cap, liveness bound, automation schedules or worker limits.
- No new `RunStatus`; no parsing of error strings; legacy records (no field) keep today's reading.
- Whether a *live* (`waiting`) hand-off counts in Needs you is unchanged — the session is open
  and a reply lands in it.

## Risks

- Several readers of `awaitingAnswerSince`; all keep working because the stamp is simply absent.
- Persisted state: the field is optional and `.catch(undefined)`, so old/new processes interoperate.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server and contract

- [ ] 1.1 Persist monitorHandoff reason/owner and stop stamping awaitingAnswerSince for it
- [ ] 1.2 Cover fresh, continuation, restart and cold-read paths in tests

### Phase 2: Cockpit and docs

- [ ] 2.1 Label monitoring hand-offs in attention and the thread footer
- [ ] 2.2 Document the field in BACKWARD_COMPATIBILITY.md
