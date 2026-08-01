# Shared Session Renderer Execution Plan

Source doc: .ai/specs/2026-07-21-shared-session-renderer.md

## Overview

### Goal

Replace the sub-agent pane's reduced transcript path with the same backend-neutral session renderer used by the main task thread, preserving main-session behavior while adding canonical grouping, tool results, attachments, scrolling, and accessibility to agent sessions.

### Scope

- Extract presentation-ready transcript sections and a single exhaustive renderer for normalized thread entries and grouped blocks.
- Share viewport, virtualization, follow-tail, jump-to-latest, card-cache, and scrollbar behavior across document and panel layouts.
- Migrate the main task thread and sub-agent sheet to the shared component without changing APIs, persisted state, event schemas, or backend mappers.
- Add regression, component, parity, and scale coverage for the reusable renderer.

### Non-goals

- No runner, mapper, `UiEvent`, SSE, API, NDJSON, or `RunRecord` changes.
- No backend-specific React presentation or speculative Codex child attribution.
- No redesign of headers, docks, composer, footer, review panel, or nested-agent navigation.
- No persisted scroll state or new configuration.

## Implementation Plan

### Phase 1: Extract and stabilize the shared renderer

1. Add regression coverage for current row keys, main transcript slots, flat/virtual switching, card cache, scrolling, and initial attachments.
2. Add the transcript section view model, main/agent adapters, and pure row builder with unit tests.
3. Centralize exhaustive `ThreadEntry` and `ThreadBlock` dispatch and add the nested-render callback seam to `ToolCard`.
4. Extract a surface-neutral transcript viewport with view-scoped scroll state and document/panel modes.
5. Migrate the main thread body to `SessionTranscript` while retaining its surrounding route composition and layout behavior.

### Phase 2: Reuse the renderer in the agent pane

6. Pass `runId` into `SubagentSheet` and render attributed entries through `SessionTranscript` in panel mode.
7. Remove the duplicate sub-agent streaming/scroll implementation and add the bounded flex layout, scrollbar gutter, jump pill, and accessible transcript label.
8. Remove `NestedEntry`, route nested tool children through the canonical renderer, and cover grouping, results, errors, diffs, images, asks, and cache namespaces.

### Phase 3: Backend and scale verification

9. Add representative Claude, Codex, and OpenCode reducer-to-component coverage proving backend-neutral rendering and the honest Codex empty state.
10. Extend dry-run/sub-agent coverage for long output and image events, including overflow, detachment, and jump-to-latest behavior.
11. Run the full repository validation gate plus E2E/manual verification preparation and update only comments that still describe the retired renderer boundary.

## Risks

- Main-thread compatibility can regress through row keys, spacing, open-card namespaces, or virtualizer measurements; focused tests preserve the existing shape before and after migration.
- Recursive rendering can introduce circular imports; orchestration stays in the session renderer and leaf cards receive a callback.
- Two active transcript surfaces can corrupt one another's scroll state; every viewport key is namespaced by run and view.
- User-facing panel behavior needs manual QA after code review; this run requests `needs-qa` and leaves QA approval to the parent workflow.
- `npm run test:e2e` was invoked during implementation but returned the repository's explicit `TEST_E2E_STATUS=skipped` outcome because the browser provider could not launch; manual/browser evidence remains for the parent QA workflow.

## Progress

PR: #756

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Extract and stabilize the shared renderer

- [x] 1.1 Add regression coverage for current main transcript behavior — 7aeacec7
- [x] 1.2 Add transcript view models, adapters, and pure row building — 7aeacec7
- [x] 1.3 Centralize exhaustive rendering and add the nested callback seam — 7aeacec7
- [x] 1.4 Extract the shared viewport and view-scoped scrolling — 7aeacec7
- [x] 1.5 Migrate the main thread to SessionTranscript — 7aeacec7
- [x] Post-review fix: decouple the renderer from run state, remove the legacy row-builder seam, and stabilize its injected ask renderer — 8c035689, 5eeaa678

### Phase 2: Reuse the renderer in the agent pane

- [x] 2.1 Migrate SubagentSheet to SessionTranscript panel mode — 7aeacec7
- [x] 2.2 Remove duplicate agent scrolling and fix the bounded panel viewport — 7aeacec7
- [x] 2.3 Remove NestedEntry and prove canonical nested rendering — 7aeacec7

### Phase 3: Backend and scale verification

- [x] 3.1 Add backend-neutral reducer-to-component coverage — 7aeacec7
- [x] 3.2 Add long transcript and image regression coverage — 9f2ec330
- [x] 3.3 Complete full validation and verification preparation — 9f2ec330
