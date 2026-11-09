# Stop painting the step of an unanswered question as a red failure

Goal: when a session closes on an unanswered `CEZ:ASK`, the step that asked reads as waiting on the user, not as failed. In the step rail it is a still amber question mark; on the Graph tab its node is a still "needs you". The run header already says "needs you".
Issue: open-mercato/cezar#2025
Source doc: .ai/specs/2026-11-04-idle-closed-attention-state.md (A3 keeps these runs under "needs you"; the rail and graph were not covered).
Builds on: #2022 (.ai/runs/2026-11-09-idle-closed-step-rail.md) and #2024 (.ai/runs/2026-11-09-idle-closed-graph-node.md). All three ship in one PR, so this plan generalizes their idle-only API instead of stacking a third PR on it.

## Decisions (owner, 2026-11-09)
- One PR for #2022, #2024 and #2025.
- Rail glyph: `CircleQuestionMarkIcon` in `stroke-pending` (never `text-pending`, which the design guardian bans), with a still `bg-pending` dot. It does not pulse, because a pulsing amber dot already marks the live step.
- Graph node: the Graph tab already draws "needs you" (a live `waiting` node) as `ring-info`/`bg-info`, so the closed-on-a-question node uses that look without the pulse, labelled "needs you".

## Scope
UI only (`packages/web`):
- `lib/attention.ts`: `RunClosure = 'idle' | 'answer'` and `runClosure(run)`. `answer` wins when both `awaitingAnswerSince` and `idleClosedAt` are set, matching `deriveAttention`. `idleClosedStepId` is renamed `closingStepId`, with its recency rule unchanged (`settleUnansweredPark` stamps the run's `finishedAt` on the step it fails).
- `routes/task-thread/step-rail.tsx`: `idleClosed?: boolean` becomes `closedAs?: RunClosure`, plus an `answer` visual.
- `routes/task-thread/run-header.tsx`: passes `closedAs={runClosure(run)}`.
- `lib/workflow-graph.ts`: `NodeRunState['status']` gains `answer`. `runOverlay`'s `{ idleStepId }` becomes `{ closing: { stepId, as } }`.
- `routes/workflow-graph/graph-node.tsx`: `STATUS.answer` and `INNER_DOT.answer`. `IDLE_CLOSED_LABEL` becomes `CLOSED_LABEL` plus `closedLabel()`.
- `routes/workflow-graph/task-graph.tsx`: `closingStepOf(run)` feeds the overlay, the details panel and the child card.
- Feature page `waiting-timeout.mdx`: one sentence on the rail and the Graph tab.

Non-goals: no contract, store or engine change, and the step stays persisted as `failed`. The run's own dot, bucket and footer are unchanged. Monitoring hand-offs belong to #1954, which changes when `awaitingAnswerSince` is stamped; whichever of the two lands second re-checks the condition.

## Implementation Plan
### Phase 1: Shared closure helper
1.1 `runClosure` and `closingStepId` in `lib/attention.ts`. Tests: answer, idle, answer beats idle, plain failure, markers off a failed run.
### Phase 2: Step rail and header
2.1 An `answer` visual in `RailIcon` and `StepDot`, and the `closedAs` prop on `StepRail`/`WorkflowSteps`. Tests: the question mark (stroke-pending, never text-pending, no spin, no running status), the still amber dot, only the latest failed step recoloured, idle unchanged. In `run-header.test.tsx`, the awaiting-answer case now expects `answer`.
### Phase 3: Graph tab
3.1 An `answer` overlay status, node style, inner dot and label. Tests: the node (ring-info, bg-info, no pulse, "needs you"), the details panel, the child card, and only the closing step recoloured. The #2024 guard "a run awaiting an answer keeps its failed node" is replaced, because that behaviour is what #2025 changes.
### Phase 4: Docs
4.1 `waiting-timeout.mdx`.

## Risks
Low. The rename touches only the three files that #2022 and #2024 introduced it in. `answer` is only ever derived, never persisted, so no stored record changes meaning.

## Progress
PR: not opened on open-mercato/cezar (owner asked for the personal fork only)

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Shared closure helper

- [ ] 1.1 Name how a run closed and the step that closed it

### Phase 2: Step rail and header

- [ ] 2.1 Draw the unanswered-question step as a still amber question mark

### Phase 3: Graph tab

- [ ] 3.1 Draw the unanswered-question node as a still "needs you"

### Phase 4: Docs

- [ ] 4.1 Note the question mark on the waiting-timeout feature page
