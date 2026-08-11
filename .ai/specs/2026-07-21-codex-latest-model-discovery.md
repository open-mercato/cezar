# Codex latest-model discovery

## TLDR

cezar currently renders a hard-coded Codex model list that has drifted far behind the models the same host's Codex CLI makes available. Replace Codex's static presets with a zero-config, host-local catalog discovered through the Codex app-server `model/list` protocol, expose that catalog through a small workspace API, and let every model picker consume the same query result. Discovery is best-effort and cached: `auto` always remains usable, an unavailable or incompatible CLI never blocks cockpit boot, and configured/custom model identifiers remain representable.

## Update — OpenCode discovery (#794)

Q1 below limited live discovery to Codex, on the grounds that only Codex had both a reported
defect and an authoritative local protocol. Issue #794 supplied the missing half for OpenCode:
`opencode models` lists what the host's configured providers actually route, and the four
hard-coded OpenCode presets had drifted exactly as the Codex ones had. OpenCode now uses the
same service, the same route (`GET /api/v1/models?runner=codex|opencode`) and the same picker
merge; its adapter is `packages/cezar/src/core/opencode-model-catalog.ts`. Everything else in
this spec — the in-memory-only cache, `auto` always usable, custom ids preserved, no persisted
catalog — applies unchanged. Claude remains a non-goal: it has no host-local catalog to ask.

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why | Confirm? |
|---|----------|-----------------|-----|----------|
| Q1 | Should this spec make all runners dynamically discover models? | Limit live discovery to Codex; keep Claude and OpenCode on their current presets. | The reported defect and an authoritative local protocol exist for Codex; widening the feature would couple unrelated provider contracts and delay the smallest complete fix. | ok |
| Q2 | Should cezar persist a model catalog in user-authored configuration? | No. Keep only a short-lived in-memory last-known-good cache and discover again automatically. | Catalogs are host/account/version dependent; requiring persisted state violates cezar's zero-config rule and creates migration burden. | ok |
| Q3 | Should hidden or legacy Codex models appear in the default picker? | No. Request the normal visible catalog and preserve arbitrary configured model IDs as a clearly marked custom option. | This matches Codex CLI's normal picker while retaining backward compatibility for users who deliberately pin a legacy/custom ID. | ok |

## Problem Statement

`web/app/src/routes/new-task-form.ts` owns `MODELS_BY_RUNNER`, a static table reused by the new-task composer and `EnginePills`. Its Codex entries stop at `gpt-5.1-codex`, `gpt-5.1-codex-mini`, and `gpt-5-codex`, and even describe `gpt-5.1-codex` as latest. On the same server, Codex CLI 0.144.6 currently offers `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`. Users therefore cannot select models in cezar that their authenticated CLI account can already run.

Updating the constants would repair only today's screenshot and drift again with the next rollout. Availability may vary by Codex version, authentication/account, rollout, provider configuration, and host. The Codex app-server protocol already provides the required authoritative source through paginated `model/list`; cezar should consume that source rather than mirror vendor catalog knowledge.

### Goals

- Show the same visible, ordered Codex catalog available to the local authenticated Codex CLI, including newly rolled-out models without a cezar release.
- Use one catalog across the new-task composer, follow-up/continue surfaces, inbox starts, and any future shared runner/model picker.
- Preserve `auto`, configured custom/legacy model IDs, and existing create/continue request semantics.
- Degrade quietly when Codex is missing, logged out, slow, old, or returns an unfamiliar payload.

### Non-goals

- Dynamic discovery for Claude or OpenCode.
- Managing model access, authentication, upgrades, reasoning effort, or service tier.
- Persisting or periodically synchronizing a vendor catalog on disk.
- Reimplementing Codex CLI's entitlement or visibility rules.

## Proposed Solution

Add a host-level `RunnerModelCatalog` service. For Codex it starts a short-lived `codex app-server` child with the same executable resolution and sanitized environment used by `CodexAppServerRunner`, performs `initialize` / `initialized`, follows every `model/list` cursor, validates the response at the boundary, filters hidden entries, and returns the server's order and descriptions. The service coalesces concurrent requests, holds a bounded in-memory last-known-good result, and terminates the child after discovery.

Expose the result from a workspace-level read-only endpoint. The cockpit fetches it once through TanStack Query and derives picker options from a single pure merge function. Static presets remain the fallback for non-Codex runners; Codex uses `auto` plus discovered visible entries, with a selected configured/custom ID appended when it is absent from the live list.

### Alternatives considered

- **Refresh the hard-coded array:** smallest diff, but it preserves the defect's cause and cannot represent account-specific rollout.
- **Parse the interactive `codex` terminal picker:** brittle, presentation-dependent, and unnecessary because the app-server exposes a structured contract.
- **Read Codex cache/config files directly:** depends on private storage formats and can disagree with current authentication or CLI logic.
- **Run a permanent discovery daemon:** adds lifecycle and resource management for data needed only on picker load; a short-lived request with cache is sufficient.

## Architecture

### Server catalog service

Create `src/core/runner-model-catalog.ts` as the backend-neutral service boundary and `src/core/codex-model-catalog.ts` as the Codex adapter. Do not leak generated Codex protocol types beyond the adapter.

The Codex adapter must reuse shared app-server process primitives extracted from `src/core/codex-app-server-runner.ts` where practical: executable selection (`CEZ_CODEX_BIN` then `codex`), `buildChildEnv`, newline-delimited JSON parsing, initialize parameters, request correlation, and bounded shutdown. Discovery must not start a thread or turn and must not mutate Codex configuration.

Flow:

1. Spawn `codex app-server` with stdio and a short discovery deadline.
2. Send `initialize` with cezar client metadata, await a valid response, then notify `initialized`.
3. Request `model/list` with `includeHidden: false`; follow `nextCursor` until null, rejecting cursor loops and enforcing a defensive page/item cap.
4. Validate every page with zod. Map vendor data to cezar's minimal `ModelOption` shape and preserve the returned order.
5. Close stdin and enforce the existing TERM/KILL grace sequence so a broken child cannot leak.
6. Cache a successful result in memory. Coalesce simultaneous refreshes into one promise.

Cache behavior:

- A fresh successful value is returned immediately within a five-minute TTL.
- After TTL, the next request refreshes; concurrent callers share it.
- On refresh failure, return the last-known-good in-memory value as stale and record a concise reason.
- With no successful value, return an empty Codex list and a non-fatal unavailable reason. The UI still renders `auto` and any configured/custom value.
- Nothing is written to `.ai/cezar/`, `~/.cezar/`, or Codex-owned files.

### API placement

Register `GET /api/models` as a workspace-level route, not a project-scoped route. Model availability belongs to the cezar host process and its Codex installation/account, so it is identical for all registered projects. It must remain behind the existing `/api/*` request-origin guard and must not be added to the project route manifest.

### Web query and option resolution

Add a typed client/query near the existing health/config queries. `new-task-form.ts` remains the home of pure selection semantics, but its helpers accept a catalog input rather than reaching into network state. `MODELS_BY_RUNNER.codex` becomes only the `auto` baseline; no dated Codex model IDs remain hard-coded as claimed-current choices.

All `EnginePills` consumers and the main composer use the same `useRunnerModels` result. The existing model value is not cleared merely because a refresh temporarily fails. When switching runners, the current behavior of dropping a model chosen for another runner remains unchanged.

## Data Model

No persisted data or migration is introduced.

```ts
type ModelOption = {
  id: string
  label: string
  description: string
}

type RunnerModelCatalog = {
  runner: 'codex'
  models: ModelOption[]
  source: 'live' | 'cache' | 'unavailable'
  stale: boolean
  reason?: string
}
```

The Codex adapter maps `Model.model` to `id`, `displayName` (falling back to `model`) to `label`, and `description` to `description`. It ignores hidden entries and safely ignores additional upstream fields. Duplicate IDs keep the first item so upstream order remains stable.

## API Contracts

### `GET /api/models?runner=codex`

The first version accepts only `runner=codex`; a missing or unsupported runner returns `{ error }` with 400 using the server's existing validation pattern.

Successful live response:

```json
{
  "runner": "codex",
  "models": [
    {
      "id": "gpt-5.6-sol",
      "label": "gpt-5.6-sol",
      "description": "Latest frontier agentic coding model."
    }
  ],
  "source": "live",
  "stale": false
}
```

Discovery failure is still HTTP 200 because the cockpit remains usable:

```json
{
  "runner": "codex",
  "models": [],
  "source": "unavailable",
  "stale": false,
  "reason": "Codex model discovery is temporarily unavailable"
}
```

Reasons are stable, sanitized one-line categories; never return raw environment data, command lines, config content, or unbounded stderr. Unexpected adapter failures are logged once per failure window and do not become server boot failures.

## UI/UX

The visual structure of the model pill and menu remains unchanged. For Codex:

- `auto — Use your Codex default model` is always first.
- While the query is pending, the pill remains operable with `auto` and any configured value; no blocking spinner or layout shift is required.
- Live visible models follow in the exact order supplied by Codex, using Codex descriptions.
- A configured or currently selected ID absent from discovery appears after the live list as `<id> — Custom or legacy model`, so settings and old run continuations never silently collapse to `auto`.
- If discovery has no live or cached result, the menu shows the usable fallback entries and a disabled `Latest Codex models unavailable` status row. It must not expose raw errors or suggest editing configuration.
- If cached data is stale, keep the normal list and add a quiet `Using cached Codex model list` status row.

The dropdown retains its existing radio semantics, keyboard navigation, focus management, mobile sizing, and dark/light/system themes. Descriptions may wrap, but model labels must not be truncated before they can be distinguished.

Evidence and illustrative proposed state:

- Current cezar hard-coded picker: `assets/codex-latest-model-discovery/current-01-cezar-static-picker.png`
- Current Codex CLI catalog on the same host: `assets/codex-latest-model-discovery/current-02-codex-cli-picker.png`
- Proposed cezar live-catalog picker: `assets/codex-latest-model-discovery/mockup-01-live-codex-models.png`

## Edge Cases & Failure Scenarios

- **Codex missing or not executable:** return unavailable; `auto` remains selectable. Backend health continues to govern whether Codex itself is offered.
- **Not authenticated / account cannot list models:** return last-known-good cache or unavailable without prompting for credentials.
- **Old CLI lacks `model/list`:** treat the method-not-found response as unavailable. Do not version-sniff or maintain a second hard-coded catalog.
- **Timeout, malformed NDJSON, invalid zod payload, non-zero exit:** kill within the bounded grace period and degrade; never reject cockpit startup.
- **Pagination loop or excessive catalog:** stop at the cap, discard the incomplete refresh, and retain last-known-good data.
- **Model rollout changes between requests:** the next TTL refresh replaces the list atomically. A selected ID that disappears stays as custom/legacy until changed.
- **Duplicate/blank IDs:** discard blank IDs and retain the first duplicate.
- **Custom `CEZ_CODEX_BIN`:** use the same resolved binary as run execution so discovery and actual execution cannot disagree by construction.
- **Multiple projects or browser clients:** share the host service, cache, and in-flight refresh without per-project processes.
- **Process shutdown during discovery:** abort the child and do not write cache state.

## Risks & Impact Review

- **Protocol drift:** `model/list` is part of the installed app-server schema but can evolve. Boundary validation, passthrough tolerance, and unavailable fallback contain the blast radius.
- **Child-process cost:** picker requests can otherwise spawn many processes. TTL caching and in-flight coalescing bound this to at most one refresh per interval per server process.
- **Credential/environment exposure:** discovery uses the runner's sanitized child environment and returns only mapped model metadata plus sanitized failure categories.
- **Compatibility:** create-run bodies, stored `RunRecord.model`, workflow YAML, CLI `--model`, config `defaultModels`, and runner interfaces remain unchanged. Arbitrary model strings remain valid at server execution boundaries.
- **Rollback:** removing the endpoint/query and restoring the previous picker source is code-only; there is no persisted state to migrate or undo.

## Testing Strategy

- Unit-test the Codex adapter with wire-faithful NDJSON fixtures for one page, pagination, hidden models, duplicates, method-not-found, malformed responses, cursor loops, timeout, and child exit.
- Unit-test cache TTL, stale-on-error behavior, in-flight coalescing, and sanitized reasons with a fake clock/adapter.
- Server route tests cover validation, live/cache/unavailable shapes, origin protection, and confirm the workspace route is not project-prefixed.
- Web pure-function tests cover live ordering, `auto` first, selected/configured custom preservation, stale/unavailable status rows, runner switching, and a newly invented model ID appearing without a source edit.
- Component tests cover radio/keyboard accessibility and all picker surfaces consuming the same query data.
- An integration smoke uses the bundled dry-run fixture rather than a real authenticated CLI so unit suites stay offline and deterministic.

## Phasing

### Phase 1 — host discovery contract

Build and verify the adapter, cache, API, fixtures, and server tests as an internal checkpoint. Do not release this checkpoint by itself: the independently deployable product increment is complete only when Phase 2 connects the catalog to every model picker.

### Phase 2 — shared dynamic picker

Move all Codex model-option resolution to the shared query and pure merge function, remove dated hard-coded Codex claims, add UI states/tests, and update screenshots.

## Implementation Plan

### Phase 1

1. Extract/reuse the minimal Codex app-server transport/process primitives needed by both the runner and discovery, preserving the `AgentRunner` protocol and existing golden fixtures.
2. Implement the zod-validated paginated Codex model adapter with bounded lifecycle and wire fixtures; test success and every failure path.
3. Implement the host `RunnerModelCatalog` cache with TTL, last-known-good fallback, coalescing, and fake-clock unit coverage.
4. Add the workspace-level `GET /api/models` route and typed response, including route/origin/validation tests.

### Phase 2

5. Add the typed web client and TanStack Query hook with a stable cache key and visibility/reconnect refetch behavior consistent with existing queries.
6. Refactor model option resolution so the composer and every `EnginePills` surface consume the same dynamic catalog while preserving configured/custom IDs.
7. Add pending, stale, and unavailable menu status rows with accessibility and responsive-theme component coverage.
8. Remove stale hard-coded Codex model entries, update docs/comments that claim fixed presets, and run the full repository validation gate plus the separate browser smoke for the affected composer flows.

## Architectural Review

- **Architectural diff:** Pass — the design adds one discovery seam and one host endpoint; it does not restate standard picker plumbing.
- **Scope cohesion:** Pass — Codex live model discovery is independently deployable; other runner catalogs remain separate future work.
- **Canonical mechanisms:** Pass — it reuses the Codex app-server transport, zod boundaries, workspace routes, TanStack Query, and existing picker components.
- **Contracts and compatibility:** Pass — all persisted/public model string surfaces remain additive and arbitrary configured IDs are preserved.
- **Reversibility:** Pass — no state is persisted; code removal restores the prior behavior.
- **Boundaries and coupling:** Pass — Codex types terminate at the adapter and the web consumes a backend-neutral shape.
- **Sensitive data:** Pass — no new sensitive fields exist and raw child errors/environment are never returned.
- **Failure scenarios:** Pass — absent, old, unauthenticated, slow, malformed, paginated, and changing CLI catalogs are specified.
- **Testability:** Pass — every implementation step names deterministic unit, route, component, or smoke evidence.
