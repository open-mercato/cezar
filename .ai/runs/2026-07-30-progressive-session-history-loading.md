# Progressive session history loading

Source doc: `.ai/specs/2026-07-28-progressive-session-history-loading.md`
Spec PR: #718 (design-only; the implementation ships separately)
Follow-up issue: #761 (pre-paint task-thread scroll arrival)

## Goal

Render the newest 100 protocol-level session items quickly, page older history only on explicit reader intent, and preserve current Plan and Agents state without retaining or replaying an entire long transcript in the browser.

## Scope

- Add bounded reverse NDJSON history projection, compact state context, opaque cursors, and additive SSE resume metadata.
- Define schema-first, versioned HTTP contracts and Node-free browser DTOs with legacy/default/project route parity.
- Move the task thread to bounded infinite history with current-state context, live continuity, accessible history controls, stable identities, and anchored pagination.
- Add deterministic server, client, compatibility, performance, and browser proof.

## Non-goals

- Do not change or migrate the append-only NDJSON format.
- Do not replace SSE, add a database/index sidecar, or introduce pagination configuration.
- Do not change the agent event vocabulary, Plan semantics, Agents grouping, or sub-agent controls.
- Do not add full-text search, arbitrary-item deep links, partial export, or eager background archive downloads.
- Do not land the unmerged design document from spec PR #718 on this implementation branch.

## Implementation Plan

### Phase 1: Server and contracts

1. Add a memory-bounded event-history module with opaque page/live cursor codecs, complete-turn projection, mixed v1/v2 item classification, compact context derivation, and focused fixtures/tests.
2. Add Node-free history DTOs and server-local zod response/query schemas, then pin type parity and shared projection/reducer fixtures without a service runtime dependency on the private API-client package.
3. Register chained, validated `/api/v1/runs/:id/history` and `/api/v1/runs/:id/history-context` routes once for legacy/default/project parity; add error, ordering, concurrency, parity, and backward-compatibility coverage.
4. Extend the existing per-run SSE route with optional live cursor, `afterSeq`, `Last-Event-ID`, and data-frame ids while preserving the no-query full replay, listener-before-replay buffering, event names/data, and race guarantees.

### Phase 2: Client hydration and state correctness

5. Add the bounded `useRunHistory()` transport with concurrent tail/context requests, bidirectional infinite-query paging, five-page retention, bounded live compaction, project scoping, deduplication, and one-time full-replay fallback.
6. Give task-thread turns/items stable source-derived identities and separate visible-page reduction from current context reduction, with race-order and full-vs-compact Plan/Agents equivalence tests.
7. Wire the task thread, Plan dock, Agents dock, and agent sheet to history state; add accessible Load/Loading/Retry/Start-of-session UI while keeping current state independent of the historical viewport.
8. Add explicit upward-intent arming, one-request-per-arm consumption, flat/virtual prepend anchoring, eviction navigation, and direct jump-to-latest reset with unit/component coverage.

### Phase 3: Performance and browser proof

9. Add deterministic long-session fixture generation and reader instrumentation that proves the tail scan and retained context are bounded.
10. Add a real-browser scenario for independent first-page readiness, intent-gated paging, five-page/DOM bounds, anchored prepends, live/current dock updates, fallback, and old-history-to-latest navigation.
11. Run the full repository validation gate in order plus the real-browser suite, verify package/runtime dependency boundaries, and capture implementation screenshots for PR evidence.

### Phase 4: Conflict refresh and deterministic route arrival

12. Merge the latest `main`, preserving progressive paging while composing it with the shared session renderer introduced after the original implementation.
13. Give the main task-thread route exclusive pre-paint ownership of cached-position or live-tail arrival while preserving the shell's generic top reset for every ordinary route.
14. Add component and real-browser regressions for ordinary-route reset, cached and live-tail task destinations, task-to-task navigation without an intermediate near-zero frame, progressive paging, and mobile behavior; then rerun the full gate and authoritative review.

## Risks

- Reverse projection can drift from the browser reducer around mixed v1/v2 twins and partial turns; shared golden fixtures and exact item-count assertions mitigate this.
- Page-to-live races can lose or duplicate events; listener-before-replay buffering, cursor high-water marks, SSE ids, and payload-level sequence dedup remain layered defenses.
- Context compaction can make Plan/Agents stale or falsely current; compact-vs-full selector equivalence is required across settled, unsettled, nested, steering, and terminal cases.
- Prepending can destabilize focus, open-card state, or scroll position in flat and virtual modes; stable identities plus pixel-anchor tests guard both paths.
- The API/SSE surface is compatibility-sensitive; all shapes are schema-first, routes are chained/versioned, and the full-replay no-query path remains intact.
- Route arrival can regress when the persistent shell scroller and task transcript both write during navigation; one explicit owner per route plus layout-effect and animation-frame assertions mitigate visible intermediate frames.

## Progress

PR: #739

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server and contracts

- [x] 1.1 Add bounded event-history projection, cursor codecs, compact context, and focused tests — cf3fa935
- [x] 1.2 Add Node-free DTOs, local zod schemas, and shared type/fixture parity tests — cf3fa935
- [x] 1.3 Register validated history routes with alias parity, error/concurrency tests, and compatibility inventory — cf3fa935
- [x] 1.4 Add SSE cursor resume, `afterSeq`, `Last-Event-ID`, frame ids, and race tests — cf3fa935

### Phase 2: Client hydration and state correctness

- [x] 2.1 Add bounded `useRunHistory()` transport, live merge, project scoping, and fallback tests — a43e214d
- [x] 2.2 Add stable row identities and separate visible/current-state reduction with equivalence tests — a43e214d
- [x] 2.3 Wire thread and docks to history state with accessible boundary states — a43e214d
- [x] 2.4 Add intent-gated paging, prepend anchoring, eviction navigation, and jump-to-latest reset — a43e214d

### Phase 3: Performance and browser proof

- [x] 3.1 Add long-session fixtures and deterministic bounded-reader/context instrumentation — 36197190
- [x] 3.2 Add real-browser progressive-history coverage and screenshot scenarios — 36197190
- [x] 3.3 Run the full validation/browser gates and verify package/runtime boundaries — 36197190

### Phase 4: Conflict refresh and deterministic route arrival

- [x] 4.1 Merge latest `main` and preserve progressive history through the shared session renderer — 765aa38a
- [x] 4.2 Add route-owned pre-paint cached/tail arrival with shell and scroller component regressions — cd79b089
- [x] 4.3 Add desktop/mobile two-thread browser proof and complete the full validation/review gates — 5bd1ea3d
