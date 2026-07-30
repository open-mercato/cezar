# Execution Plan: Session Usage Metrics

Source doc: `.ai/specs/2026-07-30-session-usage-metrics.md` (spec PR #736)
Issue: #737

## Goal

Show truthful raw input/output token totals and backend-reported cost for each Cezar run while allowing deployments to hide token usage and cost independently without breaking legacy metrics, stored runs, API consumers, or older cockpit bundles.

## Scope

- Normalize completed-turn directional usage for Claude, Codex, and OpenCode at the backend mapper seam.
- Persist durable per-step completeness checkpoints and expose optional run/group directional aggregates through canonical contracts.
- Add strict, independently resolved token-usage and cost presentation capabilities while retaining the legacy combined flag.
- Replace every current cockpit token-total surface with accessible directional usage and independently gated cost.
- Update the environment and compatibility documentation and add focused mapper, persistence, workflow, contract, capability, and UI coverage.

## Non-goals

- Do not infer USD cost, add provider pricing tables, or combine cache/reasoning detail buckets into top-level input/output totals.
- Do not backfill historical runs or relabel the legacy weighted `tokensUsed` value.
- Do not add routes, rename events, alter CLI metric output, or change authentication and project scoping.
- Do not merge the design document from spec PR #736 into this implementation branch.

## Implementation Plan

### Phase 1: Backend-normalized per-turn usage

1. Make completed-turn usage a tested backend-parity capability by tightening Codex and OpenCode turn-scoped mapper state, updating wire-faithful fixtures, and extending the parity assertion while preserving Claude's current per-result mapping.

### Phase 2: Contracts, persistence, and durable accounting

2. Add optional directional and checkpoint fields to canonical run contracts and private persistence schemas, update exactness fixtures, and prove old/new records survive save-close-reopen without stripping fields.
3. Implement persisted invocation/turn checkpoints and unique completed-turn accumulation in `RunManager`, recomputing run aggregates only when every started agent step is complete; cover pre-turn failure, retries, duplicates, interruptions, multiple turns, and historical mixes without changing v1 accounting.

### Phase 3: Capabilities and compatibility documentation

4. Add `tokenUsageMetrics` and `costMetrics` to capability resolution and the health contract, retain fail-closed derived `tokenMetrics`, and cover the strict environment truth table plus HTTP/WebSocket parity.
5. Document the two new environment flags, legacy-master precedence, payload preservation, restart requirements, and additive compatibility surfaces in `.env.example`, README, and `BACKWARD_COMPATIBILITY.md`.

### Phase 4: Browser presentation

6. Replace the browser's single visibility boolean with a backward-compatible two-dimensional `usageMetricVisibility` resolver and cover new, old, missing, and independently hidden capability payloads.
7. Build shared directional usage formatting/presentation and use it in the task-thread header, quick lists, project groups, and variant comparison with accessible labels, honest historical absence, and independent separators/gates.
8. Update desktop and mobile task-overview layouts to render semantic IN/OUT and Cost columns/items independently, including queue-span alignment and all four visibility combinations.

### Phase 5: Full verification and evidence

9. Run the configured five-command validation gate and the real dry-run cockpit E2E suite, then capture default, token-hidden-only, and cost-hidden-only task-header and overview evidence for the implementation PR.

## Risks

- Mapper state could accidentally reuse cumulative or stale provider totals; turn-boundary fixtures and cross-backend parity must prove fresh per-turn usage only.
- A crash or retry could leave a partial subtotal looking complete; invocation and turn mismatches must be persisted before runner transitions and must never be healed by later successful attempts.
- Contract additions cross browser, service, persistence, and SSE surfaces; fields remain additive/optional on run records, and current health responses remain canonical and exact.
- Independent visibility can drift across responsive surfaces; one shared resolver/formatter and four-state component coverage keep table structure, separators, and accessibility aligned.

## Progress

PR: #742

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Backend-normalized per-turn usage

- [x] 1.1 Normalize and test per-turn usage across all backends — 87860f42

### Phase 2: Contracts, persistence, and durable accounting

- [x] 2.1 Extend run contracts and persistence schemas — c1345a2c
- [x] 2.2 Add durable RunManager usage accounting — 38d41d68

### Phase 3: Capabilities and compatibility documentation

- [x] 3.1 Split token and cost presentation capabilities — abeb82e3
- [x] 3.2 Document environment and compatibility contracts — 2ae6abac

### Phase 4: Browser presentation

- [x] 4.1 Add backward-compatible usage visibility resolution — b0822f1b
- [x] 4.2 Add shared directional usage presentation — b0822f1b
- [x] 4.3 Update responsive task-overview layouts — b0822f1b

### Phase 5: Full verification and evidence

- [ ] 5.1 Run validation, browser E2E, and capture evidence
