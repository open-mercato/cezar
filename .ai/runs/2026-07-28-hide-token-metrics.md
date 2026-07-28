# Execution Plan: Hide Token Metrics

Source doc: .ai/specs/2026-07-28-hide-token-metrics.md
Spec PR: #722
Issue: #481

## Goal

Add the strict opt-in `CEZ_HIDE_TOKEN_METRICS=1` presentation policy so embedded cezar cockpits omit token usage and monetary cost from every current user-facing renderer while preserving telemetry, APIs, and the zero-config default.

## Scope

- Extend the server health capability and browser API-client contract.
- Gate the quick task list, tasks overview table/cards, task-thread header, and variant comparison through one visibility resolver.
- Add focused regression tests for strict env parsing, legacy health behavior, semantic table structure, separators, and all four UI surfaces.
- Document the new environment and health contracts in `.env.example`, README, and `BACKWARD_COMPATIBILITY.md`.
- Run the complete repository validation gate and browser smoke checks in both default and hidden modes.

## Non-goals

- Do not remove or redact token/cost telemetry from run records, events, persistence, or API responses.
- Do not change CLI output or add a user preference/settings screen.
- Do not split cost and token visibility into separate switches.
- Do not add a new endpoint, WebSocket topic, or browser subscription.
- Do not merge or duplicate the design-only spec PR.

## Risks

- Removing values without their headers/cells could break table semantics or queue-row `colSpan`; focused DOM assertions cover the hidden layout.
- A renderer could bypass the shared capability and leak accounting metadata; every current `formatCost`/`compactTokens` display site is enumerated and tested.
- Adding a required health capability can drift fixtures; server and browser contract tests must be updated together, while the UI resolver remains compatible with an older missing field.
- The environment variable is boot-time operational input; docs must require restart and avoid implying supported live reconfiguration.

## Implementation Plan

### Phase 1: Runtime contract and documentation

- 1.1 Add the strict `tokenMetrics` health capability to server and shared DTOs with unit/parity coverage.
- 1.2 Document `CEZ_HIDE_TOKEN_METRICS=1` in `.env.example`, README, and `BACKWARD_COMPATIBILITY.md`.

### Phase 2: Complete cockpit suppression

- 2.1 Add the shared visibility resolver and gate the quick list and task-thread header with focused tests.
- 2.2 Gate both tasks-overview layouts, including structural headers/cells and queue-row spans, with focused tests.
- 2.3 Gate variant comparison and add enabled/disabled coverage.

### Phase 3: End-to-end verification

- 3.1 Run the complete validation gate and browser smoke checks with metrics visible by default and hidden under `CEZ_HIDE_TOKEN_METRICS=1`.

## Progress

Implementation PR: #724 (https://github.com/open-mercato/cezar/pull/724)

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Runtime contract and documentation

- [x] 1.1 Add the strict `tokenMetrics` health capability to server and shared DTOs with unit/parity coverage. — b90d877e
- [x] 1.2 Document `CEZ_HIDE_TOKEN_METRICS=1` in `.env.example`, README, and `BACKWARD_COMPATIBILITY.md`. — 0bc2b306

### Phase 2: Complete cockpit suppression

- [x] 2.1 Add the shared visibility resolver and gate the quick list and task-thread header with focused tests. — b911d2cd
- [x] 2.2 Gate both tasks-overview layouts, including structural headers/cells and queue-row spans, with focused tests. — 76db7cc3
- [x] 2.3 Gate variant comparison and add enabled/disabled coverage. — af5759e9

### Phase 3: End-to-end verification

- [x] 3.1 Run the complete validation gate and browser smoke checks with metrics visible by default and hidden under `CEZ_HIDE_TOKEN_METRICS=1`. — af5759e9
