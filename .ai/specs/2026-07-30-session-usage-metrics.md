# Show Input/Output Tokens and Cost per Session

## 📝 TLDR

Replace the cockpit's single weighted token total with explicit `IN` and `OUT` token counts alongside the session's reported USD cost. Keep all three values visible by default, while allowing deployments to hide token usage and cost independently through strict runtime environment flags.

The implementation is additive: normalized v2 usage already carries raw input/output counts for Claude, Codex, and OpenCode; this work persists those counters on step/run records and exposes separate presentation capabilities. The existing `tokensUsed`, `costUsd`, `CEZ_HIDE_TOKEN_METRICS`, event types, and API fields remain compatible.

## Resolved assumptions (autonomous defaults)

| # | Applied default | Rationale |
|---|---|---|
| Q1 | Keep `CEZ_HIDE_TOKEN_METRICS=1` as a legacy master switch that hides both token usage and cost; add `CEZ_HIDE_TOKEN_USAGE=1` and `CEZ_HIDE_COST=1` for independent control. | Existing embedded deployments already rely on the shipped flag. An alias preserves their behavior while the two new strict opt-outs provide the requested matrix. |
| Q2 | Display the normalized protocol's top-level `usage.input` and `usage.output` values exactly; do not fold cache or reasoning detail buckets into them. | Provider detail buckets do not share one overlap contract: Codex reports cached/reasoning counts as subsets of top-level direction totals, while Claude/OpenCode expose additional buckets. Summing them would double-count some backends. Raw top-level values are the smallest backend-neutral truth. |
| Q3 | Old records without directional counters show an honest absence (`— / —` in fixed table cells; no usage fragment on compact surfaces). Never relabel legacy weighted `tokensUsed` as input or output. | The old value is deliberately cost-weighted and cannot be split or safely backfilled. Honest absence avoids fabricated telemetry and requires no migration. |
| Q4 | Replace the old token total on every current browser usage surface: quick lists, task overview table/cards, task-thread header, project groups, and variant comparison. | A deployment policy and a session metric must mean the same thing everywhere. Limiting the change to one screen would recreate the drift that the shared visibility helper was introduced to prevent. |
| Q5 | Keep directional display and independent token/cost visibility in one spec and one atomic implementation. | They form one user-visible session-usage presentation contract: the requested four-state visibility matrix applies to the exact IN/OUT + cost unit introduced here. Shipping either half alone leaves the requested outcome incomplete and creates a transient second policy for the obsolete weighted-total UI. |

None of these defaults weakens security, data scoping, or compatibility, and none requires human confirmation.

## 📝 Problem Statement

Cezar currently presents a single `tokensUsed` value plus optional `costUsd` for each run. The token number comes from the legacy v1 runner stream and is not a raw count for every backend: Claude cache-read and cache-creation tokens are deliberately weighted in `packages/cezar/src/core/usage.ts` so the number roughly follows cost. It is useful for legacy console output and old recordings, but it cannot answer the basic operational question, "how much went into the model and how much came out?"

The normalized v2 protocol already answers that question. Every supported backend emits cumulative `usage.updated` events with `TokenUsage.input` and `TokenUsage.output`, enforced by the golden-fixture parity test in `packages/cezar/src/core/ui-parity.test.ts`. `UiEventSink` persists those snapshots to NDJSON, but `RunManager` does not copy the direction counters into `runs.json`; list and header views therefore cannot render them without replaying the full event log.

Presentation control is also too coarse. The implemented `.ai/specs/2026-07-28-hide-token-metrics.md` design has one `CEZ_HIDE_TOKEN_METRICS=1` flag that hides tokens and cost together. The requested follow-up explicitly needs four valid deployment states:

| Token usage | Cost | Example use |
|---|---|---|
| visible | visible | Default local cockpit with full accounting context. |
| hidden | visible | A cost-focused embedded or managed service that does not want token internals. |
| visible | hidden | A service that exposes throughput but treats provider pricing as irrelevant or commercially sensitive. |
| hidden | hidden | Existing `CEZ_HIDE_TOKEN_METRICS=1` deployments and fully accounting-agnostic embeds. |

The change must preserve zero config, historical recordings, public run/health schemas, backend parity, and the browser-only scope of the existing presentation policy.

## 📝 Proposed Solution

Persist two optional raw counters—`inputTokens` and `outputTokens`—on each agent step and aggregate them onto the run. Render them as one compact directional metric (`IN 184.7k · OUT 2.4k`) wherever the old total appeared, followed by the existing reported cost when available.

Split runtime presentation policy into two current capabilities:

- `tokenUsageMetrics`: false when `CEZ_HIDE_TOKEN_USAGE=1` or the legacy `CEZ_HIDE_TOKEN_METRICS=1` is set.
- `costMetrics`: false when `CEZ_HIDE_COST=1` or the legacy `CEZ_HIDE_TOKEN_METRICS=1` is set.
- Keep `tokenMetrics` as the backward-compatible combined value, equal to `tokenUsageMetrics && costMetrics`. An older cockpit talking to a newer server therefore hides both whenever either dimension is restricted; it may hide more than necessary, but it never reveals a value the deployment opted out of.

Only the exact string `1` enables any opt-out. The flags change presentation only: collection, NDJSON persistence, run responses, SSE, CLI output, and cost calculation are unaffected by whether either flag is set. Directional telemetry separately adds optional fields and normalized turn usage as specified below. Environment flags are evaluated by the server and conveyed through the existing health snapshot; the prebuilt SPA never reads `import.meta.env`.

### Alternatives considered

1. **Rename `CEZ_HIDE_TOKEN_METRICS` to mean only tokens.** Rejected because existing deployments use it to hide both values. Reinterpreting it would reveal cost after an upgrade.
2. **Remove `tokenMetrics` immediately.** Rejected because `/api/v1/health` is protected and old browser bundles can remain cached. The derived legacy field is cheap and gives fail-closed presentation behavior.
3. **Reconstruct directional usage by replaying NDJSON on every list request.** Rejected because `runs.json` is the list index, list rendering must stay cheap, and old recordings still cannot be split when they contain v1-only telemetry.
4. **Infer cost from input/output counts for Codex.** Rejected because model prices, cache discounts, reasoning rates, subscriptions, and provider billing rules are external and unstable. Cezar continues showing only backend-reported `costUsd`.
5. **Fold cache/reasoning detail into `IN`/`OUT`.** Deferred until `TokenUsage` defines mutually exclusive direction buckets across all runners. Langfuse's usage model demonstrates why this matters: details must be non-overlapping or totals and inferred cost double-count. Cezar should not guess across inconsistent upstream schemas.

## 📝 Research

[Langfuse's token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) validates the high-level UI vocabulary—input usage, output usage, and cost are separate dimensions—and warns that detail buckets may overlap unless normalized explicitly. This spec adopts the separate directional display and reported-cost preference, while deliberately deferring arbitrary bucket aggregation.

[OpenHands metrics](https://docs.openhands.dev/sdk/guides/metrics) exposes detailed token usage at the LLM-call level and accumulated cost at conversation level. That supports Cezar's existing shape: raw session updates are normalized at the runner seam, then accumulated into a run record for cheap cockpit summaries.

Both systems carry more pricing/observability machinery than Cezar needs. Cezar keeps its local, provider-reported, zero-config model and adds no tokenizer, pricing table, database, analytics endpoint, or cloud dependency.

## 📝 Architecture

```text
backend wire usage
  └─ <backend>-ui-mapper.ts
       └─ usage.updated { input, output, total, details?, costUsd? }
            └─ turn.completed.usage (per completed model turn)
                 └─ RunManager additive turn accounting
                 ├─ StepState.inputTokens? / outputTokens?
                 └─ RunRecord.inputTokens? / outputTokens? (sum of known steps)
                      └─ existing run/group APIs + SSE run snapshots
                           └─ shared usage presentation helper
                                ├─ IN / OUT tokens (tokenUsageMetrics)
                                └─ USD cost (costMetrics)

process.env
  └─ resolveCapabilities()
       └─ /api/v1/health + health WebSocket snapshot
            └─ one session-global TanStack Query health cache
```

### Runner and event seam

`usage.updated` remains raw, cumulative telemetry for a backend-owned conversation/session. It is useful for live gauges and diagnostics but is not a safe accounting delta across process resume: Codex's `tokenUsage.total`, for example, can include the resumed thread's history. Run persistence therefore consumes the existing optional `turn.completed.usage` field, whose contract in this feature becomes **usage for that completed turn only**.

Normalize per-turn usage inside each backend mapper, where upstream counter semantics are known:

- Claude already attaches the result frame's current-turn usage to `turn.completed`.
- Codex clears its pending per-turn snapshot at each `turn/started`, accepts `tokenUsage.last` only while that turn is active, consumes it exactly once at the matching `turn/completed`, and clears it again. A usage notification before the turn or a completion without a fresh notification cannot reuse the preceding turn's values. It never uses `tokenUsage.total` as a persisted delta.
- OpenCode starts a new turn-scoped message-id set at `turn.started`, adds message ids first observed or updated during that turn, and sums only the latest `usageByMessage` snapshots for that set when `session.idle` completes the turn. It then clears the set. Pre-turn updates and messages retained from an earlier turn cannot leak into the next completion.

This keeps provider knowledge inside `packages/cezar/src/core/*-ui-mapper.ts` and preserves the seam: `RunManager` handles one backend-neutral event. Golden fixtures and mapper tests cover multiple turns, completion without a fresh usage update, a usage update before `turn.started`, duplicate completion, and resumed history for Codex and OpenCode. `ui-parity.test.ts` also gains a row requiring non-zero `turn.completed.usage.input` and `.output` for Claude, Codex, and OpenCode.

`RunManager` tracks persisted completeness checkpoints on the current step. Immediately before each `startSession` attempt it increments `usageInvocationsStarted` and a RunManager-owned `usageInvocationEpoch`. The first unique `turn.started` in that epoch increments `usageInvocationsObserved`; every unique `turn.started` increments `usageTurnsStarted`; and `usageTurnsRecorded` increments only when that turn completes with valid directional usage. Uniqueness is scoped by the invocation epoch plus `turnId`, so provider-local ids may restart at `turn_1` after Continue without colliding. A duplicate start or completion in one invocation is ignored.

The invocation counters close the pre-turn failure gap: a runner that throws, exits, or is interrupted before emitting `turn.started` durably leaves `usageInvocationsStarted > usageInvocationsObserved`. A later metered retry increments both sides once and therefore cannot erase the earlier mismatch. The invocation checkpoint is persisted before launching the runner, and the turn counters are written before or atomically with their corresponding transitions, so a crash, abandoned turn, missing usage frame, or retry cannot leave a falsely complete subtotal.

Valid `turn.completed.usage` is added exactly once to the current step's optional direction counters. The `UiEventSink` already persists the completed-turn snapshot; no replay or cumulative-delta heuristic is needed. Repeated `usage.updated` events, corrected cumulative splits, and process restarts cannot inflate the run index because none is treated as an additive accounting event.

### Run store and contracts

Extend the canonical API zod schemas in `packages/contract/src/runs.ts` **and** the persistence schemas in `packages/cezar/src/runs/store.ts`. Today `RunStore.open` parses private, stripping `stepStateSchema`/`runRecordSchema` definitions rather than the contract package; both schema layers must accept the new fields until they are deliberately unified. Add a save-close-reopen regression test so a server restart cannot silently strip directional accounting. The store's `updateStep` continues recomputing run aggregates on every step patch:

- The user-visible **session** in this spec is one Cezar `RunRecord` (the task session shown in the cockpit), aggregated across its agent steps and turns. A backend `AgentSession`, vendor thread, process, and workflow step remain internal accounting boundaries, not separate UI rows.
- Each agent step optionally persists `usageInvocationsStarted`, `usageInvocationsObserved`, `usageTurnsStarted`, `usageTurnsRecorded`, and `usageInvocationEpoch` alongside `inputTokens`/`outputTokens`. A step is complete for directional accounting only when it has at least one observed invocation and tracked turn, every launched invocation produced a turn (`usageInvocationsStarted === usageInvocationsObserved`), every tracked turn was recorded (`usageTurnsStarted === usageTurnsRecorded`), and both direction counters exist.
- A run exposes directional aggregates only when every started agent step (`iterations > 0`) is complete by that rule. Then each run field is the sum across those complete steps.
- If an agent iteration exists with zero tracked turns, or any step contains an abandoned, unmetered, malformed, interrupted, or historical turn, both run aggregates stay absent. This prevents a partial suffix from being presented as the whole session. A later metered retry does not erase the earlier mismatch.
- `tokensUsed` remains required, weighted, and independently aggregated exactly as today. There is intentionally no invariant that `tokensUsed === inputTokens + outputTokens`.
- `costUsd` remains optional and reported by the backend; no cost is fabricated for Codex.

Add the optional direction counters to the group-variant DTO so the comparison route does not need another lookup. All fields are additive and optional so pre-feature `runs.json` files and old run records continue parsing without migration.

### Capability resolution

Extend `Capabilities` in `packages/cezar/src/server/capabilities.ts` and the canonical health schema in `packages/contract/src/health.ts`:

```ts
interface Capabilities {
  // existing fields...
  tokenMetrics: boolean       // legacy combined compatibility value
  tokenUsageMetrics: boolean  // current token presentation policy
  costMetrics: boolean        // current cost presentation policy
}
```

Resolution is strict and deterministic:

```ts
const hideAll = env.CEZ_HIDE_TOKEN_METRICS === '1'
const tokenUsageMetrics = !hideAll && env.CEZ_HIDE_TOKEN_USAGE !== '1'
const costMetrics = !hideAll && env.CEZ_HIDE_COST !== '1'
const tokenMetrics = tokenUsageMetrics && costMetrics
```

The server reads the values through the existing `resolveCapabilities` path. `/api/v1/health` and the local `health` WebSocket snapshot remain one byte-identical source; no route or topic is added. There is no unversioned `/api/*` route.

### Browser presentation

Replace `tokenMetricsVisible` with a small pure resolver returning both booleans, while keeping a compatibility export if useful to avoid a flag-day edit:

```ts
type UsageMetricVisibility = { tokens: boolean; cost: boolean }

function usageMetricVisibility(health?: HealthResponse): UsageMetricVisibility {
  const legacy = health?.capabilities?.tokenMetrics !== false
  return {
    tokens: health?.capabilities?.tokenUsageMetrics ?? legacy,
    cost: health?.capabilities?.costMetrics ?? legacy,
  }
}
```

Missing health and old payloads remain visible by default. The canonical zod schema describes the current server and therefore requires the new booleans; the browser resolver intentionally accepts a `Partial<HealthResponse['capabilities']>` compatibility view, as the existing `tokenMetricsVisible` helper does today. Typed fetches are compile-time checked but do not reject an older JSON payload before this resolver runs. Containers read `useHealth()` only; they must not create per-component subscriptions. Presentational components receive `showTokens` and `showCost` independently and default both to true in focused tests.

## 📝 Data Model

```ts
type StepState = {
  // existing fields
  tokensUsed: number
  inputTokens?: number
  outputTokens?: number
  usageInvocationsStarted?: number
  usageInvocationsObserved?: number
  usageTurnsStarted?: number
  usageTurnsRecorded?: number
  usageInvocationEpoch?: number
  costUsd?: number
}

type RunRecord = {
  // existing fields
  tokensUsed: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

type GroupVariant = {
  // existing fields
  tokensUsed: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}
```

The new fields are non-negative finite counters validated at both the public-contract and store-persistence zod boundaries. Direction counters contain top-level raw provider values accumulated from v2 events; invocation and turn checkpoints make completeness durable across retries and restarts. The full run API already exposes its persisted `steps`, so these optional checkpoint fields are additive members of that response even though their semantics are internal accounting; summary DTOs such as `GroupVariant` receive only `inputTokens` and `outputTokens`. Cache-read, cache-write, and reasoning detail remain available in NDJSON `usage.updated` events but are not folded into these fields in this phase.

No migration or replay backfill runs. Old records remain valid with absent fields; deleting `.ai/cezar/` still rebuilds ordinary state as before.

## 📝 API Contracts

Existing run and group responses gain optional `inputTokens` and `outputTokens` fields through their canonical contract schemas. Full run responses also carry the optional invocation/turn checkpoint fields on their existing step entries because the public `RunRecord` schema mirrors persisted `runs.json`; group summaries omit those internal checkpoints. SSE `run` snapshots carry the same additive fields because they serialize `RunRecord`; `run-event`/`ui-event` names and `usage.updated` payloads do not change.

The existing health response gains two required fields on current servers:

```json
{
  "capabilities": {
    "tokenMetrics": true,
    "tokenUsageMetrics": true,
    "costMetrics": true
  }
}
```

Browser compatibility rules:

- Missing new fields fall back to `tokenMetrics` when present, otherwise visible.
- Current servers always emit all three values.
- `tokenMetrics` is retained and derived; it is not an independent source of policy.
- A legacy client hides both dimensions if either current dimension is hidden, preventing accidental disclosure after partial opt-out.

Update `BACKWARD_COMPATIBILITY.md` for the additive health/run fields and legacy env semantics. No new endpoint, request body, auth behavior, CORS exposure, or project-scoping rule is introduced.

## 📝 UI/UX

Use the compact label `IN {value} · OUT {value}` everywhere; `IN` and `OUT` are visible text, not icon-only labels. The values use the existing `compactTokens` formatter and tabular numerals.

- **Task-thread header:** replace `{total} tokens` with `IN 184.7k · OUT 2.4k`; keep `$0.31` as its own following metadata item. Each item obeys its own capability and separators are generated only between rendered items.
- **Desktop task table:** replace the `Tokens` column with an `IN / OUT` column whose cell renders `184.7k / 2.4k` with an accessible label of `Input 184.7k tokens, output 2.4k tokens`. Keep `Cost` independent. Removing either header removes every corresponding cell.
- **Responsive task cards and quick lists:** render compact `IN` and `OUT` labels before cost. When only one dimension is visible, do not leave a dangling dot or empty line.
- **Variant comparison and project groups:** use the same directional label and independent gates so one variant cannot expose a deployment-hidden value.

Historical behavior is honest:

- Fixed table cells show `— / —` when both new fields are absent, or the known side plus an em dash if only one is present.
- Dense cards, headers, and subtitles omit the whole directional fragment when both are absent.
- The old weighted total is never shown under an `IN`, `OUT`, or raw-token label.
- Cost keeps current absence formatting: an unknown/unreported cost is omitted on compact surfaces and shown as a dash in a dedicated table cell.

The independent capability matrix must be exercised at desktop and mobile widths. Current/proposed evidence lives beside this spec:

- Current real cockpit: [`assets/session-usage-metrics/current-01-task-session.png`](assets/session-usage-metrics/current-01-task-session.png)
- Current real overview: [`assets/session-usage-metrics/current-02-tasks-overview.png`](assets/session-usage-metrics/current-02-tasks-overview.png)
- Proposed session header: [`assets/session-usage-metrics/mockup-01-task-session.png`](assets/session-usage-metrics/mockup-01-task-session.png)
- Proposed overview and independent controls: [`assets/session-usage-metrics/mockup-02-tasks-overview.png`](assets/session-usage-metrics/mockup-02-tasks-overview.png)

Accessibility requirements:

- Table headers and data cells stay structurally aligned in all four visibility states.
- Screen-reader text expands `IN`/`OUT` to input/output tokens at least once per compact unit.
- Values use text in addition to spatial order; color is not meaning-bearing.
- Existing row activation, links, focus targets, zoom behavior, and 390 px mobile layout remain unchanged.

## 📝 Edge Cases & Failure Scenarios

- **Only v1 telemetry exists:** directional fields remain absent; the UI never fabricates a split.
- **A backend emits usage but no USD cost:** token directions render and cost remains absent. Codex is the expected common case.
- **A backend emits cost but no directional usage:** cost renders independently.
- **Repeated or corrected cumulative updates:** they remain diagnostic `usage.updated` snapshots and do not contribute to persisted additive turn accounting.
- **Malformed negative/non-finite data:** mapper guards reject it; no run counter is patched.
- **Process resume:** each mapper emits current-turn usage. Codex uses a freshly received `tokenUsage.last`, not the lifetime `total`; the RunManager invocation epoch prevents reused provider-local turn ids from colliding.
- **Metered then unmetered turns:** the second turn increments `usageTurnsStarted` but not `usageTurnsRecorded`; both run aggregates disappear rather than preserving the first turn's misleading subtotal.
- **Failure before a turn starts:** the invocation-start checkpoint is persisted before `startSession`; if no `turn.started` arrives, `usageInvocationsStarted > usageInvocationsObserved` survives later metered attempts and keeps the run aggregate absent.
- **Retry or restart during a turn:** the durable invocation and turn mismatches survive later metered attempts and keep the run aggregate absent.
- **Zero-turn or mixed old/new steps:** any started agent step with no tracked complete turn—or with historical data that lacks checkpoint fields—keeps both run aggregates absent.
- **Unknown env spellings:** only exact `1` hides a metric; `true`, `yes`, `0`, empty, and typos preserve the visible default.
- **Legacy and current flags combined:** legacy hide-all wins. Current flags never re-enable a dimension hidden by the legacy flag.
- **Health pending or old server:** metrics remain visible using the backward-compatible default.
- **Queue rows and variant groups:** dynamic column counts/metadata arrays prevent incorrect `colSpan` and dangling separators.

## 📝 Risks & Impact Review

### Accounting accuracy

The largest risk is presenting non-comparable provider detail buckets as equivalent. This phase deliberately labels and stores only top-level direction counts and keeps provider-reported cost separate. It does not infer billing from counts.

### Double-counting sessions

`usage.updated` is cumulative and may cover a resumed vendor thread. Treating it as a delta would inflate totals. Persist only mapper-normalized `turn.completed.usage`, strengthen backend parity around its per-turn meaning, and prove resume behavior with golden fixtures before the UI consumes the run fields.

### Compatibility

Run fields and current health fields are additive. The legacy `tokensUsed` and `tokenMetrics` contracts remain. Old clients fail closed for presentation when only one new dimension is hidden; old run records parse without migration. Update the protected-surface inventory and contract type-exactness tests in the same implementation.

### Configuration contract

Adding `CEZ_HIDE_TOKEN_USAGE` and `CEZ_HIDE_COST`, and clarifying `CEZ_HIDE_TOKEN_METRICS`, requires `.env.example` in the same commit plus the README environment table. A missing documentation update is a bug under the repository's zero-config rules.

### Layout drift

Independent visibility doubles the prior presentation matrix. Centralize the resolver and metric fragment; component tests must assert semantics and separators in all four states rather than relying on snapshots.

### Rollback

Unset the new flags and restart Cezar to restore the visible default. Reverting the feature leaves optional fields in existing `runs.json`. The current older store schemas strip unknown keys on their next save, so rollback may discard the new optional telemetry, but the underlying run still parses and operates through the retained legacy fields. No migration, irreversible state, or external side effect exists.

## 📋 Phasing

### Phase 1 — Directional session-usage presentation contract

Ship mapper-normalized per-turn accounting, optional run aggregates, separate health capabilities, documentation, and every browser renderer in one atomic feature. The internal commits may follow the dependency order below, but the branch is not published as a supported partial configuration: the requested contract is the complete IN/OUT + cost unit and its four visibility states.

## 📋 Implementation Plan

### Phase 1 — Directional session-usage presentation contract

1. Make `turn.completed.usage` per-turn telemetry a tested backend-parity capability. Keep Claude's current result mapping; make Codex clear and consume a fresh `tokenUsage.last` at explicit turn boundaries; make OpenCode maintain a turn-scoped message-id set over `usageByMessage`. Update wire-faithful multi-turn fixtures for missing usage, pre-start updates, duplicate completion, and resumed history proving old totals or messages are not reused.
2. Extend `stepStateSchema`, `runRecordSchema`, and `groupVariantSchema` in `packages/contract/src/runs.ts` with optional non-negative directional fields and the full-run step checkpoint fields; keep checkpoint metadata out of `GroupVariant`. Mirror the persisted step/run additions in `packages/cezar/src/runs/store.ts`, or replace those private schemas with a shared non-stripping source. Update type-exactness fixtures and add a save-close-reopen test proving old records parse and every new field survives restart.
3. Add persisted invocation-start/observed counters, a runner-invocation epoch, and unique-turn accounting in `RunManager`: checkpoint each invocation before `startSession`, count its first unique `turn.started` once, count every unique turn start once, add valid completion usage once, and record completion once. Recompute run aggregates only when every started agent step has at least one observed invocation and tracked turn, `usageInvocationsStarted === usageInvocationsObserved`, and `usageTurnsStarted === usageTurnsRecorded`; cover startSession failure and process exit before a turn, a later metered retry that must not heal either mismatch, zero-turn steps, metered-then-unmetered turns, duplicate start/completion, process interruption/resume, multiple turns, live follow-ups, and mixed historical/current steps. Keep v1 token/cost handling byte-for-byte compatible.
4. Add `tokenUsageMetrics` and `costMetrics` to `resolveCapabilities` and `packages/contract/src/health.ts`, retain derived `tokenMetrics`, and add the full strict-env truth table to capability/health tests. Verify `/api/v1/health` and the health topic expose the same snapshot.
5. Document `CEZ_HIDE_TOKEN_USAGE=1`, `CEZ_HIDE_COST=1`, and legacy-master precedence in `.env.example`, README, and `BACKWARD_COMPATIBILITY.md`; explicitly state that telemetry/API payloads are preserved and a restart is required.
6. Replace the browser's boolean resolver with `usageMetricVisibility`, covering new-server, old-server, missing-health, legacy hide-all, token-only hidden, cost-only hidden, and both-hidden cases.
7. Build a shared directional usage fragment/formatter with compact visual text and expanded accessible text. Use it in the task-thread header, task quick lists/project groups, and variant comparison; add tests for historical absence and all visibility combinations.
8. Update both task-overview layouts. Replace the total token column/card item with IN/OUT, gate IN/OUT and Cost independently, compute semantic columns/queue spans from rendered columns, and add desktop/mobile tests for all four capability states.
9. Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, and `npm run test:package`, then run `npm run test:e2e` against the real dry-run cockpit. Capture the task header and overview in default mode plus token-hidden-only and cost-hidden-only states to prove the matrix and zero-config default.
