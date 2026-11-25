# Execution plan — idle-closed attention state ("closed · idle")

Source doc: .ai/specs/2026-11-04-idle-closed-attention-state.md (lands with #1934)
Issue: #1933

## Goal

A task whose session the inactivity timer closed because nobody replied settles to an orange
"closed · idle" state instead of a red "failed": not counted as a failure, not under "Needs you",
still resumable with Continue.

## Scope

- Run record + HTTP contract: optional `idleClosedAt` on a `failed` run (mirrors #1290's
  `awaitingAnswerSince`), carried on the task row, runs-index row and dashboard cost row.
- Engine: stamp it at the Continue idle settle and at the first-run idle settle (keyed on
  `state.idleClosed`, never the message); delete the dead `idleFailed` branch; mark the idle
  step-end so the thread does not render it as a red failure.
- Dashboards and telemetry: exclude idle closes from failure counts and `task_failed`.
- Cockpit: `idle` tone (`bg-conflict`), attention rung, thread footer, live-overlay carry-through.
- `BACKWARD_COMPATIBILITY.md` entry and the waiting-timeout feature page.

## Non-goals

- The spec document itself (ships in #1934).
- The step rail's red dot for the failed step.
- The `CEZ:ASK` prose false positive in `parseAskMarkerResult`.
- No backport: a new presentation state, not a regression; ships in 0.19.

## Deviations from the spec

- Archiving keeps `idleClosedAt` (the spec lists `store.ts:670`, which would repaint an archived
  idle close red; the spec's own A7 calls it an ordinary outcome).
- Insights drop idle closes from `finished`, not only from `failed`, keeping done + failed = finished.
- No CHANGELOG entry: the file has no `# Unreleased` section; the PR body notes the `task_failed` drop.

## Risks

- `risk-high` surfaces (run-record format, HTTP contract), but purely additive; old records stay red.
- 20 vitest cases in 5 files fail on a clean `main` on macOS (`/tmp` symlink, locale clock); unrelated.

## Progress

PR: #1935

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Record and contract

- [x] 1.1 Add idleClosedAt to the contract and the run store with the failed-only invariant — 8d7859da

### Phase 2: Engine

- [x] 2.1 Stamp idleClosedAt at both idle settles, drop the dead branch, flag the idle step-end — 890ee6a6

### Phase 3: Server rows, dashboards and telemetry

- [x] 3.1 Carry idleClosedAt on row builders and exclude idle closes from failure counts and task_failed — 568ef5b0

### Phase 4: Cockpit

- [x] 4.1 Add the closed · idle attention rung, dot tone, footer and transcript handling — 77544790

### Phase 5: Docs

- [x] 5.1 Add the BACKWARD_COMPATIBILITY entry and the waiting-timeout page section — 3caf2189

### Phase 6: Review fixes

- [x] 6.1 Stamp idleClosedAt only when the walk failed on the idle close itself — 389bbf4d
- [x] 6.2 Label idle-closed results in the dashboard feed kicker — c6e0ca4f
