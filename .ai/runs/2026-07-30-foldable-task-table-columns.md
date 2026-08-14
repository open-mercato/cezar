# Implement Foldable Task Table Columns

Source doc: .ai/specs/2026-07-30-foldable-task-table-columns.md
Spec PR: #740 (design-only)

## Goal

Let users fold optional columns in the desktop Tasks table, with Branch folded by default, while preserving Status and Task, persisting choices in workspace UI state, and keeping mobile cards unchanged.

## Scope

- Extend the shared workspace UI-state response and bounded PUT contract for `taskTable.expandedColumns`.
- Validate the existing workspace UI-state route through shared contract middleware and cover persistence, passthrough, and request bounds.
- Add a stable task-column registry, normalization/default helpers, and an ordered optimistic persistence controller.
- Render the desktop table header, widths, and row cells from the shared registry with accessible fold/expand controls.
- Extend unit and route tests for defaults, accessibility, rapid writes, capability-hidden metrics, alignment, queued rows, and mobile isolation.
- Run the full repository validation gate and verify both default and persisted states in the production-built cockpit.

## Non-goals

- Do not change mobile task-card content or ordering.
- Do not add a table framework, column settings menu, new HTTP endpoint, WebSocket topic, SSE event, migration, or required configuration.
- Do not merge the design-only spec PR into this implementation branch.
- Do not change task sorting, filtering, row navigation, inline rename, or token-metric capability semantics beyond registry-driven rendering.

## Implementation Plan

### Phase 1: Complete persisted foldable-column capability

1. Extend the shared workspace UI-state response schema and add the bounded PUT input schema; wire the existing route middleware to the shared write contract and add server contract/persistence tests.
2. Add the ordered task-column registry and pure normalization, resolution, and immutable-update helpers with unit tests for defaults, fixed columns, malformed state, overrides, and unknown ids.
3. Add `useTaskTableColumns()` with optimistic whole-object preservation, serialized keepalive PUTs, stale-response suppression, authoritative reconciliation, and failure invalidation/toast coverage.
4. Refactor the desktop Tasks table so registry-derived headers, widths, and row cells stay aligned, optional headers fold accessibly, capability-hidden metrics remain absent, queued CPU/Mem structure remains correct, and mobile cards stay unchanged.
5. Extend Tasks overview tests for mouse/keyboard interaction, accessible names and state, defaults and persistence, alignment, hidden metrics, queued rows, active/archive/search reuse, and mobile isolation.
6. Run the complete validation gate, boot the production UI, exercise fresh and persisted column states, and capture PR screenshot evidence for Branch folded plus Workflow and Branch folded.

## Risks

- Header and row structures can drift when token/cost capability columns are absent or queued rows span CPU and Mem; one ordered registry plus alignment tests is the guardrail.
- Workspace UI-state writes are shallow at the top level; toggles must preserve unknown `taskTable` siblings and the complete expanded-column map.
- Rapid responses can overwrite newer optimistic state unless writes are serialized and response adoption is sequence-gated.
- The optional workspace-state contract is a compatibility surface; response passthrough and request-only bounds must remain distinct and exact.
- Folded icon controls can become undiscoverable or inaccessible; visible focus, tooltips, stable order, action-oriented labels, and real-browser verification are required.

## Progress

PR: #743

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Complete persisted foldable-column capability

- [x] 1.1 Extend the shared workspace UI-state response and bounded PUT contracts with route and persistence tests. — 71e8b0ae
- [x] 1.2 Add the task-column registry and pure state helpers with unit coverage. — c68d3e79
- [x] 1.3 Add the optimistic serialized workspace persistence controller with lifecycle and failure coverage. — 96540194
- [x] 1.4 Refactor the desktop Tasks table to render accessible registry-driven foldable columns. — 1a5640af
- [x] 1.5 Extend Tasks overview behavior, alignment, capability, queued-row, and mobile tests. — 74703f5e
- [x] 1.6 Run the full validation gate and capture production UI evidence for fresh and persisted states. — 68ebb0a1
