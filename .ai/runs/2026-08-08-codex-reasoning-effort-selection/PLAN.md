# Execution plan — Codex reasoning-effort selection

Source spec: `.ai/specs/2026-08-08-codex-reasoning-effort-selection.md`

## Tasks

> Authoritative status table. `Status` is `todo` or `done`; the first `todo` row is the resume point. Every Step lands as exactly one commit and its row is flipped in that same commit.

| Phase | Step | Title | Exec | Status | Commit |
|-------|------|-------|------|--------|--------|
| 1 | 1.1 | Discover and expose per-model Codex effort capabilities | inline | done | 9996937b |
| 1 | 1.2 | Add effort to contract, workflow, and persistent run schemas | inline | done | 8ed58528 |
| 2 | 2.1 | Resolve and persist effective effort across runs and continuations | inline | done | 52c65145 |
| 2 | 2.2 | Send effort only through Codex turn starts | inline | done | bcfa6669 |
| 3 | 3.1 | Wire typed HTTP entry points and headless CLI effort input | inline | done | pending |
| 3 | 3.2 | Add the New Task and planned-run Effort picker | inline | todo | — |
| 3 | 3.3 | Reuse Effort selection in Inbox, GitHub handoff, and Continue | inline | todo | — |
| 4 | 4.1 | Complete cross-surface regression coverage and compatibility checks | inline | todo | — |

## Goal

Allow a user to select a discovered Codex reasoning-effort value per task or workflow step, preserve that explicit choice through a run and continuation, and send it only as the Codex App Server `turn/start` `effort` parameter.

## Scope

- Discover current and legacy Codex App Server effort capability formats and expose them through the typed model catalog.
- Add additive `reasoningEffort` input/state fields, step-over-run precedence, native-settings lock enforcement, explicit reset semantics, and clear non-Codex validation errors.
- Support all existing launch surfaces: REST, inline workflows, YAML, Inbox, GitHub handoff, Continue, New Task, approved plans, and `cezar run --effort`.
- Add focused unit/contract/runner/UI tests, then run the full configured validation and integration gates.

## Non-goals

- No global Cezar effort default, `config.json` key, or `CEZ_*` environment variable.
- No model-effort translation for Claude or OpenCode.
- No migration of existing run state or workflow YAML.
- No change to Codex native behavior when `reasoningEffort` is omitted.

## Risks

- The App Server catalog may change shape or become unavailable. Normalize only known safe values and degrade to native defaults with no picker override.
- The work crosses contract, persistence, runner and UI boundaries. Keep fields optional and use contract-parity/old-record tests to protect compatibility.
- Reasoning effort can alter latency and cost. Never silently select a non-native default; require an explicit discovered model and value.
- The user-facing picker needs browser/integration evidence. If the local browser environment cannot run, record the reason while still completing automated tests.

## External References

No `--skill-url` material was supplied. The source spec has already adopted the official Codex App Server contract and OpenCode's provider-specific precedent.

## Implementation Plan

### Phase 1 — Capability and durable public shape

#### Step 1.1 — Discover and expose per-model Codex effort capabilities

- Extend the model-option contract and generic catalog transport with optional normalized effort metadata.
- Parse both string and object `supportedReasoningEfforts` formats, retaining valid order and descriptions while ignoring malformed entries.
- Update Codex catalog fixtures and API/catalog tests without changing behavior for unavailable or cached catalogs.

#### Step 1.2 — Add effort to contract, workflow, and persistent run schemas

- Define bounded effort input schemas in `packages/contract`; migrate Continue and Inbox-start request shapes out of `server.ts` into the contract.
- Add optional effort fields to public/persistent run and step schemas plus matching service schemas.
- Add `workflowStepDef.reasoningEffort` and preserve portable-skill shorthand rules.
- Cover old records, workflow round trips, typed routes, and contract parity.

### Phase 2 — Runtime resolution and backend boundary

#### Step 2.1 — Resolve and persist effective effort across runs and continuations

- Resolve `step.reasoningEffort > run.reasoningEffort > native Codex default` after the effective backend is known.
- Enforce `modelsLocked`, mixed-workflow and unsupported-runner behavior at entry and manager boundaries.
- Persist the resolved choice on agent steps; retain/recover it through queue hydration, restart and Continue, including explicit reset and runner-switch clearing.
- Add manager/workflow/continuation regression tests.

#### Step 2.2 — Send effort only through Codex turn starts

- Extend `AgentRunSpec` and pass it into the Codex runner.
- Conditionally include `effort` in `turn/start`; prove it is absent for native default and never supplied to `thread/start`, resume, steer, Claude, or OpenCode.
- Extend the mock App Server assertions and runner tests.

### Phase 3 — Entry points and user controls

#### Step 3.1 — Wire typed HTTP entry points and headless CLI effort input

- Adopt the contract body schemas in chained server routes and pass the value through create, Continue, and Inbox-start paths.
- Add `--effort <level>` to CLI parsing, help, validation, and `RunManager` input.
- Cover 400/409 and CLI error/success behavior without changing absent-field behavior.

#### Step 3.2 — Add the New Task and planned-run Effort picker

- Extend per-project draft normalization and form resolvers with the optional picker state.
- Render model-filtered effort values next to Model, reset it on runner/model changes, and omit it for `Codex default`.
- Add planned-run body support and focused form/component tests for lock/catalog/model states.

#### Step 3.3 — Reuse Effort selection in Inbox, GitHub handoff, and Continue

- Extend the shared engine picker and follow-up composition rather than creating bespoke controls.
- Preserve existing engine selection when effort is untouched; provide the explicit Continue reset value when the user chooses `Codex default`.
- Test all shared-surface payloads and accessibility labels.

### Phase 4 — Cross-surface regression coverage

#### Step 4.1 — Complete cross-surface regression coverage and compatibility checks

- Add any missing API-client, persistence/recovery, mixed-workflow and UI integration coverage revealed by the combined feature.
- Validate source/route parity and upgrade safety before the final gate.
