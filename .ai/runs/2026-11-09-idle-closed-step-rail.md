# Paint the idle-closing step orange in the step rail

Goal: on an idle-closed run, the step that closed it reads "closed · idle" orange in the run header's step rail, matching the run's own dot, instead of a red failure.
Issue: open-mercato/cezar#2022
Source doc: .ai/specs/2026-11-04-idle-closed-attention-state.md (the idle-closed state, #1934/#1935).

## Scope
UI only (`packages/web`): a step-picking helper in `lib/attention.ts` next to `isIdleClosed`, an `'idle'` rail visual in `routes/task-thread/step-rail.tsx`, and the one-prop wiring in `run-header.tsx`.

Non-goals: no contract, store or engine change (the step stays persisted as `failed`); `railProgress` unchanged (an idle-closed step still counts as terminal); plain failed and cancelled steps keep the danger X; the awaiting-answer (yellow) case is #2025; the Graph tab's red node is #2024.

## Implementation Plan
### Phase 1: Pick the idle-closing step
1.1 `idleClosedStepId(steps)` in `lib/attention.ts`: the `failed` step with the latest `finishedAt`, else the last `failed` step in order; never keyed on error text or on equality with `run.idleClosedAt` (graph path stamps its own time). Unit tests.
### Phase 2: Rail treatment
2.1 `'idle'` in `RailVisual` (`railVisual(status)` stays pure); optional `idleClosed` on `StepRail`/`WorkflowSteps`; `CirclePauseIcon` `text-conflict` in the rail, `bg-conflict` dot in the summary. Tests: idle step renders `idle` in rows and dots; only the latest of two failed steps is recoloured; no flag → unchanged. Prove red without the fix.
2.2 `run-header.tsx` passes `idleClosed={isIdleClosed(run)}`; header test: idle-closed run → idle dot, awaiting-answer and plain failed runs → failed dot.
### Phase 3: Verification
3.1 Full validation gate (`validation.commands`) and review pass.

## Risks
Low. A run with several failed steps (graph retries) relies on recency; the fallback to order covers records without `finishedAt`. `task-thread.test.tsx` reads `data-visual` and must stay green.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Pick the idle-closing step

- [ ] 1.1 Add idleClosedStepId helper with tests

### Phase 2: Rail treatment

- [ ] 2.1 Add the idle rail visual and idleClosed prop with tests
- [ ] 2.2 Wire isIdleClosed into the run header with a header test

### Phase 3: Verification

- [ ] 3.1 Run the full validation gate and review pass
