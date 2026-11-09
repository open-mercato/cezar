# Paint the idle-closing node orange on the Graph tab

Goal: on an idle-closed run, the Graph tab draws the node of the step that closed it in the orange "closed · idle" tone, with that label, instead of a red failure, matching the run header and the step rail.
Issue: open-mercato/cezar#2024
Source doc: .ai/specs/2026-11-04-idle-closed-attention-state.md (the idle-closed state, #1934/#1935; colour and label from its A2).
Depends on: #2026 (#2022), which adds `idleClosedStepId` in `lib/attention.ts`. This branch is stacked on #2026's head and must be rebased onto `main` once #2026 merges.

## Scope
UI only (`packages/web`):
- `lib/workflow-graph.ts`: `'idle'` in `NodeRunState['status']`. `runOverlay` takes an optional `{ idleStepId }` and marks that node `'idle'`.
- `routes/workflow-graph/graph-node.tsx`: `STATUS.idle` (`ring-2 ring-conflict` / `bg-conflict` / "closed · idle") and `INNER_DOT.idle`.
- `routes/workflow-graph/task-graph.tsx`: computes the idle step id with `isIdleClosed` + `idleClosedStepId` for the run, shows "closed · idle" in the details panel, and recolours a child card's idle-closing step from the child's own record.
- Feature page `waiting-timeout.mdx`: one clause for the Graph tab.

Non-goals: no contract, store or engine change, and the step stays persisted as `failed`. Plain failed and cancelled nodes keep their look. Edge drawing and taken-edge counts are unchanged. The awaiting-answer case is #2025. The editor's simulation (`workflow-graph.tsx` `simStatus`) never produces `'idle'` and is untouched.

## Implementation Plan
### Phase 1: Overlay
1.1 `runOverlay(graph, run, { idleStepId })` marks the matching step node `'idle'`. Tests: the idle node; two failed steps where only the named one is recoloured; no option → unchanged.
### Phase 2: Graph tab rendering
2.1 `STATUS.idle` and `INNER_DOT.idle` in `graph-node.tsx`. An inner step's tooltip reads its label, not the raw key. Tests: the node's ring, dot and `aria-label`, and a red control.
2.2 `task-graph.tsx` wiring: the run's idle step id goes into `runOverlay`, the details panel shows "closed · idle", and `SubtaskNodeCard` recolours the child's idle-closing step. Tests: an idle-closed run renders the idle node and the panel label; a failed run without `idleClosedAt` stays red; the child card's inner dot. Prove they fail without the fix.
### Phase 3: Docs
3.1 `waiting-timeout.mdx` names the Graph tab next to the step rail.

## Risks
Low. React Flow in jsdom does not measure nodes, so render tests read the DOM attributes (`data-node-status`, `aria-label`, classes) rather than layout. The child card relies on the child's own `idleClosedAt`; a child closed for another reason stays red, which is correct.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Overlay

- [x] 1.1 Mark the idle-closing step in runOverlay with tests — e672db3e

### Phase 2: Graph tab rendering

- [x] 2.1 Add the idle node and inner-dot styles with tests — dde0a884
- [x] 2.2 Wire the idle step into the Graph tab, details panel and child card with tests — dde0a884

Regression evidence: with the source reverted to #2026's head, the new tests fail (overlay 1 of 37, task-graph 3 of 6). The guards (other failed step, plain failure, awaiting answer, no option) pass both ways by design.

### Phase 3: Docs

- [x] 3.1 Note the Graph tab on the waiting-timeout feature page — 671fca07
