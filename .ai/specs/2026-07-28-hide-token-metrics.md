# Hide Token Metrics in Embedded Cockpits

## 📝 TLDR

Add an opt-in environment switch for deployments that embed cezar into services where model pricing and token consumption are irrelevant or misleading. When enabled, the cockpit hides both monetary cost and token-usage values from every user-facing surface while preserving telemetry collection and API compatibility.

The zero-config default remains unchanged: token metrics stay visible unless the server starts with `CEZ_HIDE_TOKEN_METRICS=1`. The server exposes the resolved presentation capability through `/api/health`; the browser consumes that one value everywhere it renders run metadata.

## Resolved assumptions (autonomous defaults)

| # | Applied default | Rationale |
|---|---|---|
| Q1 | Use one strict opt-in flag, `CEZ_HIDE_TOKEN_METRICS=1`, for both token counts and cost. | Issue #481 explicitly groups the two values as accounting metadata that embedded deployments do not want to display. One reversible presentation switch avoids a configuration matrix with no requested use case. |
| Q2 | Preserve token/cost telemetry in run records, events, and API responses; expose only a presentation capability. | This is the smallest additive contract. It does not rewrite persisted state, weaken diagnostics, or break API consumers. |
| Q3 | Limit the behavior to the browser cockpit. | The issue asks to stop displaying values “everywhere in the app.” No CLI output problem is reported, and expanding the flag beyond the cockpit would create an unrelated compatibility surface. |

## 📝 Problem Statement

Mercato sandboxes and similar services can embed cezar while being agnostic to model prices. The current cockpit renders token counts and costs in task lists, task headers, and variant comparison, which presents implementation-detail accounting as product information. Issue #481 asks for one environment-controlled way to suppress those values everywhere in the app and explicitly extends the scope from cost to token usage.

The display logic is currently distributed across four user-facing areas:

- `packages/web/src/components/task-quick-list.tsx` shows token usage in variant subtitles.
- `packages/web/src/routes/tasks-overview.tsx` shows token and cost values in both table columns and task-card metadata.
- `packages/web/src/routes/task-thread/run-header.tsx` shows lifetime tokens and cost in the run header.
- `packages/web/src/routes/compare-variants.tsx` shows token/cost spend in each comparison column.

The backend must continue collecting this telemetry. Run scheduling, persisted `RunRecord` compatibility, SSE reconciliation, and downstream API clients must not change merely because one deployment considers the values inappropriate for its UI.

## 📝 Proposed Solution

Add `CEZ_HIDE_TOKEN_METRICS` as a boot-time, strict opt-in presentation flag:

- Undefined, empty, `0`, `true`, and every value other than the exact string `1` preserve today’s UI.
- `CEZ_HIDE_TOKEN_METRICS=1` makes the server report `capabilities.tokenMetrics: false`.
- The default server response reports `capabilities.tokenMetrics: true`.
- The cockpit treats a missing capability as visible. This keeps a newer web client fail-open for display when talking to an older server or reading a stale health snapshot.

Every token/cost renderer consumes the same resolved browser value. When hidden, the UI omits the metric elements themselves—including table headers and cells—rather than rendering placeholders or empty spacing. No token or cost field is removed from events, run records, or APIs.

### Alternatives considered

1. **Separate cost and token flags.** Rejected because the issue’s follow-up explicitly asks to hide both and no independent deployment need is known. It would double UI states and tests without delivering requested value.
2. **Strip telemetry from API payloads.** Rejected because display policy is not data-retention policy. It would widen the change into event, persistence, and public-contract code and make diagnostics worse.
3. **Read `import.meta.env` in the SPA.** Rejected because cezar ships one prebuilt static cockpit. Runtime deployment flags belong to the Node server and must be conveyed through an existing runtime boundary.
4. **Introduce a new settings screen or persisted preference.** Rejected because the owner asked for a deployment-wide environment switch, and requiring authored state would violate cezar’s zero-config rule.

## 📝 Architecture

The established server-capability path is the canonical seam:

```text
process.env
  └─ resolveCapabilities()
       └─ /api/health + health WebSocket snapshot
            └─ session-global TanStack Query health cache
                 └─ token-metric visibility helper
                      ├─ quick task list
                      ├─ tasks overview
                      ├─ task header
                      └─ variant comparison
```

### Server

Extend `Capabilities` in `packages/cezar/src/server/capabilities.ts` with:

```ts
tokenMetrics: boolean
```

`resolveCapabilities(env)` returns `tokenMetrics: env.CEZ_HIDE_TOKEN_METRICS !== '1'`. The function already centralizes strict environment interpretation for `CEZ_REMOTE`, `CEZ_FOLLOWUPS`, and `CEZ_SINGLE_PROJECT`, so no second env parser should be introduced.

The existing `healthSnapshot()` in `packages/cezar/src/server/server.ts` already publishes `capabilities` byte-identically through `/api/health`, `/api/v1/health`, and the local WebSocket `health` topic. No route, event topic, polling loop, or per-project endpoint is added.

### Shared contract

Add `tokenMetrics` to `Capabilities` in `packages/api-client/src/dto/types.ts`, with documentation that `false` is a presentation policy and does not imply telemetry was discarded. Current servers always emit the field, while the shared browser-facing type keeps it optional so a newer cockpit can still consume an older health response. This is an additive field on the protected health response; update `BACKWARD_COMPATIBILITY.md` to inventory it.

### Cockpit

Add one small pure resolver near the health client:

```ts
tokenMetricsVisible(health: HealthResponse | undefined): boolean
```

It returns `health?.capabilities.tokenMetrics !== false`. UI containers read `useHealth()`—which is already a pure session-global cache read—and pass the resolved boolean into presentational renderers. They must not open a WebSocket or create another subscription.

Presentational components keep a default of `true` where needed so focused tests and reusable components retain current behavior unless they explicitly exercise the hidden state.

This follows the useful part of Langfuse’s open-source trace UI: a centralized `showCostTokens` view preference is resolved once and propagated to all metric renderers, while the underlying observation data remains present. Cezar uses its deployment capability rather than a per-user preference because #481 is a server-owner policy. It deliberately skips Langfuse’s additional timeline/color-coding complexity because cezar has no equivalent dependent visualization.

## 📝 Data Model

No persisted data changes.

- `RunRecord.tokensUsed`, `RunRecord.costUsd`, per-step token usage, normalized UI events, and NDJSON remain unchanged.
- Existing runs need no migration.
- Hiding metrics does not redact or delete accounting data.
- The only new serialized field is additive `HealthResponse.capabilities.tokenMetrics`.

## 📝 API Contracts

The existing health response gains one field:

```json
{
  "capabilities": {
    "localHandoff": true,
    "followups": false,
    "singleProject": false,
    "tokenMetrics": true
  }
}
```

With `CEZ_HIDE_TOKEN_METRICS=1`, only `tokenMetrics` changes to `false`.

Contract rules:

- `/api/health` and `/api/v1/health` remain byte-identical.
- The local `health` WebSocket topic carries the same capability value.
- Project-scoped run and event endpoints keep returning token/cost data.
- CORS exposure does not materially widen: the new boolean reveals only server-owner display policy, not values, paths, credentials, or telemetry.
- Consumers must treat a missing field as the legacy visible default.

## 📝 UI/UX

When `tokenMetrics` is `true` or absent, the cockpit is pixel-for-pixel unchanged.

When it is `false`:

- The quick-list variant subtitle contains the runner only; it does not leave a dangling separator.
- Tasks overview cards omit the token and cost metadata items.
- The desktop tasks table omits the `Tokens` and `Cost` column headers and corresponding cells. Queue-position layout adjusts to the reduced column count, with no blank columns.
- The task-thread header omits both lifetime token count and cost while preserving workflow, branch, diff, reference, and agent metadata with correct separators.
- Variant comparison omits the spend element entirely; status and variant letter retain their existing alignment.
- Loading health defaults to the current visible behavior, avoiding a layout that hides metrics transiently on every startup.

The switch does not add a banner, tooltip, settings row, or disabled placeholder. Embedded users should simply see a cockpit where accounting metadata is not part of the information architecture.

Current and proposed overview evidence:

- Current: [`assets/hide-token-metrics/current-01-tasks-overview.png`](assets/hide-token-metrics/current-01-tasks-overview.png)
- Proposed with the flag enabled: [`assets/hide-token-metrics/mockup-01-tasks-overview.png`](assets/hide-token-metrics/mockup-01-tasks-overview.png)

Accessibility requirements:

- Removing the two table headers must remove their data cells as well, preserving semantic column alignment.
- No visually hidden token/cost text should remain available to screen readers when the flag is enabled.
- Existing keyboard navigation and row activation behavior remain unchanged.

## 📝 Edge Cases & Failure Scenarios

- **Unknown or misspelled env value:** the flag stays off and metrics remain visible. Strict activation matches other cezar flags and avoids surprising deployments.
- **Health request pending or failed:** metrics remain visible using the legacy default; the rest of the cockpit already owns health error behavior.
- **Old health payload without `tokenMetrics`:** metrics remain visible.
- **Changing the host environment after boot:** unsupported. Environment variables are boot-time deployment inputs; restart cezar after changing the flag. Per-request capability resolution is an implementation detail, not a live-reconfiguration contract.
- **Queued task row:** removing metric columns must not break the queue-position `colSpan`.
- **Zero or unknown telemetry:** existing omission/placeholder behavior applies only when metrics are enabled; disabled mode never renders metric-specific placeholders.
- **Variant group with mixed telemetry:** all variants follow the deployment capability consistently.

## 📝 Risks & Impact Review

### Compatibility

The change is additive. Default behavior, persisted state, run/event DTOs, and CLI output remain unchanged. The health capability must be added to the typed API client and the protected-surface inventory in the same change.

### Layout drift

The main regression risk is hiding values but leaving table headers, separators, or empty cells. Focused component tests must assert both absence and structural alignment in disabled mode.

### Incomplete coverage

Distributed renderers can drift as new UI is added. The implementation should centralize the visibility resolver, document it as the required gate for future token/cost presentation, and include a source-level or component-level coverage test for all four current surfaces. A new renderer that bypasses the resolver is a bug.

### Documentation

Adding a `CEZ_*` variable requires `.env.example` in the same commit and the README environment table because the switch is user-facing. `BACKWARD_COMPATIBILITY.md` must include the new env contract and additive health field.

### Rollback

Unset `CEZ_HIDE_TOKEN_METRICS` and restart cezar to restore current display behavior. Reverting the implementation is safe because no data migration or persisted preference exists.

## 📋 Phasing

### Phase 1 — Complete token-metric presentation policy

Ship the runtime capability contract and all cockpit renderer gates atomically. Strict env parsing, typed health exposure, documentation, complete UI suppression, and regression coverage form one independently useful feature; publishing the flag without consumers would create a documented no-op.

## 📋 Implementation Plan

### Phase 1 — Complete token-metric presentation policy

1. Extend `resolveCapabilities` and both server/client `Capabilities` types with `tokenMetrics`; add unit cases proving only `CEZ_HIDE_TOKEN_METRICS=1` disables it and update health fixtures/parity expectations. The application remains functional with metrics visible by default.
2. Document `CEZ_HIDE_TOKEN_METRICS=1` in `.env.example`, the README environment table, and `BACKWARD_COMPATIBILITY.md`, explicitly stating that it changes presentation only. Run focused capability and health tests.
3. Add the shared `tokenMetricsVisible` resolver with legacy/missing-health tests. Wire the quick task list and task-thread header through it, adding assertions that tokens, cost, separators, and accessible text disappear only in disabled mode.
4. Wire both tasks-overview layouts through the same resolver. Remove the table columns structurally, correct queue-row spans, and add enabled/disabled tests for cards, table headers, cells, and queued rows.
5. Wire variant comparison through the same resolver and add tests for both modes, including variants whose usage/cost values are non-zero.
6. Run the full repository validation gate and the UI smoke suite with `CEZ_HIDE_TOKEN_METRICS=1`, capturing the tasks overview and task header to confirm no user-facing token or cost text remains. Re-run without the flag to prove the zero-config default is unchanged.
