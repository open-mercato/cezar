# Codex latest-model discovery implementation

Source doc: .ai/specs/2026-07-21-codex-latest-model-discovery.md
Source spec: .ai/specs/2026-07-21-codex-latest-model-discovery.md

## Tasks

> Authoritative status table. `Status` is one of `todo` or `done`. On landing a Step, flip `Status` to `done` and fill the `Commit` column with the short SHA. The first row whose `Status` is not `done` is the resume point for `om-auto-continue-pr-loop`. Step ids are immutable once a Step has a commit.

| Phase | Step | Title | Status | Commit |
|-------|------|-------|--------|--------|
| 1 | 1.1 | Share Codex app-server transport primitives | done | 5feef31 |
| 1 | 1.2 | Discover and validate paginated Codex models | done | 4df0f36 |
| 1 | 1.3 | Cache runner model catalogs in memory | done | 8ab905d |
| 1 | 1.4 | Expose the workspace model-catalog API | done | 00b956d |
| 2 | 2.1 | Add the shared web model-catalog query | done | 4279637 |
| 2 | 2.2 | Resolve dynamic models across every picker | done | 0a5362d |
| 2 | 2.3 | Render accessible catalog status rows | done | f7688fb |
| 2 | 2.4 | Remove stale presets and complete UI coverage | done | 5a81bdb |

## Goal

Keep cezar's Codex model picker synchronized with the visible models exposed by the host's authenticated Codex CLI, while preserving zero-config startup and graceful fallback.

## Scope

- Extract reusable Codex app-server lifecycle and request primitives without changing runner behavior.
- Add validated, paginated Codex model discovery and a bounded in-memory catalog cache.
- Add the workspace-level `GET /api/models?runner=codex` endpoint.
- Feed a single typed TanStack Query result into all shared model pickers.
- Preserve `auto`, configured/custom model IDs, accessibility, theming, and responsive behavior.
- Add deterministic server, adapter, cache, pure-function, component, and browser coverage.

## Non-goals

- Dynamic model discovery for Claude or OpenCode.
- Persisting model catalogs or adding user-authored configuration.
- Changing run creation, continuation, workflow, or stored model-string contracts.
- Managing Codex authentication, reasoning effort, service tier, or hidden models.

## Risks

- Codex protocol drift is contained by tolerant zod boundaries and sanitized unavailable responses.
- Child-process leaks are prevented through bounded deadlines and TERM/KILL shutdown.
- Cross-cutting picker changes can regress custom model preservation; shared pure functions and component tests cover this.
- The endpoint is workspace-level and must not enter project route parity manifests.

## External References

- None.

## Implementation Plan

### Phase 1 — host discovery contract

#### Step 1.1 — Share Codex app-server transport primitives

- Extract the minimal executable resolution, sanitized environment, NDJSON request correlation, initialization, and bounded shutdown primitives from the Codex runner.
- Keep `AgentRunner` behavior and protocol fixtures byte-compatible.
- Add focused regression coverage for the shared transport seam.

#### Step 1.2 — Discover and validate paginated Codex models

- Implement the Codex adapter for `model/list`, including hidden filtering, stable order, duplicate/blank handling, cursor-loop and size caps.
- Add wire-faithful fixtures and unit tests for success, pagination, method absence, malformed data, timeout, and child exit.

#### Step 1.3 — Cache runner model catalogs in memory

- Add the backend-neutral `RunnerModelCatalog` service with five-minute TTL, in-flight coalescing, stale last-known-good fallback, and sanitized unavailable reasons.
- Cover cache semantics with injected time and adapter fakes.

#### Step 1.4 — Expose the workspace model-catalog API

- Register and validate `GET /api/models?runner=codex` as a workspace-level route behind the existing origin guard.
- Add route tests for live, cached, unavailable, invalid, and non-project-scoped behavior.

### Phase 2 — shared dynamic picker

#### Step 2.1 — Add the shared web model-catalog query

- Mirror the API response type into the web boundary and add the typed client/query with a stable cache key.
- Follow existing reconnect and visibility refetch conventions.

#### Step 2.2 — Resolve dynamic models across every picker

- Refactor pure option resolution to merge `auto`, the live catalog, and configured/current custom IDs.
- Feed the same query data into the composer, `EnginePills`, inbox starts, follow-up/continue surfaces, and settings consumers.

#### Step 2.3 — Render accessible catalog status rows

- Add pending-safe, stale-cache, and unavailable status rows without blocking selection or shifting the layout.
- Preserve radio keyboard behavior, focus, mobile sizing, and light/dark/system themes with component coverage.

#### Step 2.4 — Remove stale presets and complete UI coverage

- Remove dated hard-coded Codex model claims and update affected documentation/comments.
- Add end-to-end coverage proving a newly invented Codex model appears everywhere without a source edit.
- Run the full validation gate and browser smoke, capturing screenshot evidence for the PR.
