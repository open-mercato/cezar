# Execution plan — settings number stepper

**Brief:** "Max parallel tasks" and "Extra monitoring sessions" should not be dropdowns but an input with up/down arrows where any integer can be typed — for both the global (workspace) and the project scope.

## Goal

Replace the three concurrency `<select>`s in Settings with one reusable integer stepper (type a number, or step with arrow buttons / ArrowUp / ArrowDown).

## Scope

- New `IntegerStepper` component (`packages/web/src/components/integer-stepper.tsx`).
- Global → Resources: *Max parallel tasks*, *Extra monitoring sessions* (`resources-section.tsx`).
- Project scope: per-project *Max parallel tasks* (`MaxParallelSelect` in `projects-section.tsx`, rendered by `project-general.tsx` and the projects list). Empty field = inherit the workspace limit.
- Unit tests + the monitoring e2e spec updated for the new control.

## Non-goals

- Server bounds stay as they are (`maxParallel` 1–16, `maxMonitoringSessions` 0–16, enforced by the contract + workspace schema). The stepper enforces the same range and shows an inline error outside it. Raising the ceiling would be a separate server/contract change.
- Other selects in Settings (wake mode, auto-resume, composer defaults) are untouched.

## Implementation Plan

### Phase 1: Stepper component
- 1.1 Add `IntegerStepper`: draft text, commit on blur / Enter / debounced after stepping, Escape reverts, inline range error, optional empty (= null), revert on a rejected save.

### Phase 2: Adopt it
- 2.1 Global Resources: max parallel + extra monitoring sessions.
- 2.2 Project scope: per-project max parallel (empty = inherit).
- 2.3 Update unit tests and the monitoring e2e spec.

## Risks

- Found during e2e: Enter followed by blur re-sent the same value while the first save was in flight, keeping the shared save pending (fixed in 21e3ff9d / 8e29748a). The monitoring e2e spec also had a pre-existing race (it fails 3/3 on origin/main): it filled the wake interval while that input was disabled by the pending capacity save; fixed in 1da97508.
- `settings-resources.e2e.ts` "cold load renders the persisted count" fails on origin/main as well — pre-existing, untouched here.

- Saves are no longer instant-on-change: typing commits on blur/Enter, arrows commit after a short debounce so a burst of clicks is one PUT.

## Progress

PR: #1075

PR: #1075

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Stepper component

- [x] 1.1 Add IntegerStepper component — 22eed8a3

### Phase 2: Adopt it

- [x] 2.1 Global Resources: max parallel + extra monitoring sessions — 7348f043
- [x] 2.2 Project scope: per-project max parallel — 63cd0ed2
- [x] 2.3 Update unit tests and the monitoring e2e spec — 9e4ce23d

### Phase 3: Review

- [x] 3.1 Self-review fix: flush a pending stepped save on unmount — 5f9f983e
