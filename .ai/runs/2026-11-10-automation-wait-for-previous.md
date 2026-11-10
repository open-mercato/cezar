# Execution plan — automation "wait for previous execution" (#1801)

Source doc: GitHub issue #1801 (spec section added to `.ai/specs/2026-09-14-automations-redesign.md`)

## Goal

An opt-in `task.waitForPrevious` boolean on every automation kind: while a run this automation
launched is still active, a new occurrence or match does not start a second run.

## Scope

- Contract first: `waitForPrevious` on `automationTaskSchema` (contract + service), optional, absent = today.
- Active = `queued` / `running` / `waiting` (a parked `CEZ:MONITORING` run is `waiting`); `review` and
  terminal states count as finished (issue Q2 proposal). Matched by automation id, across revisions and
  variants, from both live and persisted runs (a second cockpit's runs count).
- Schedules **skip** the overlapping occurrence (log `skipped` naming the run, `nextRunAt` advances —
  no burst). `manual` Run now, Retry, deferred starts and a `once` schedule bypass the guard.
- Polls **hold**: the cycle stops before reserving a receipt, logs one `skipped` row naming the run,
  and keeps its cursor/checkpoint, so the held matches are re-read and launched by the first poll after
  the run settles. No new receipt status, no new state-file shape.
- Editor checkbox + hint next to the Dispatch row; `cez automation add --wait-for-previous`; schema
  reference lists the key.

Non-goals: concurrency limits above 1, project-level setting (maintainer comment), queue caps,
`maxParallel` changes, any behavior change for automations without the box.

## Risks

- A long-held poll freezes its cursor; the existing truncation ladder covers a busy window, and the
  idle re-baseline at boot may drop matches held longer than the lookback (documented).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contract and schema

- [ ] 1.1 Add waitForPrevious to the contract and service task schemas

### Phase 2: Guard

- [ ] 2.1 Active-run lookup wired into every automation handle
- [ ] 2.2 Schedule guard (skip) and poll guard (hold) with tests

### Phase 3: Surfaces

- [ ] 3.1 Editor checkbox + hint, CLI flag, schema reference, spec section
