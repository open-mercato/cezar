# Codex reasoning-effort selection

## 📝 TLDR

cezar will let a person choose Codex reasoning effort for an individual task, continuation, inbox/GitHub handoff, headless invocation, or a specific workflow step. The selection is available only for an explicitly chosen Codex model and only from values discovered from that local Codex App Server. `Codex default` means no override is sent.

The feature is additive and zero-config: it introduces `reasoningEffort` on run and workflow inputs, but no `defaultEffort` in `config.json`. The runner sends the resolved value solely as `turn/start.params.effort`. Old runs and YAML stay valid. Claude and OpenCode reject an explicit value rather than silently ignoring a Codex-specific option.

## 📝 Decisions

1. `modelsLocked` locks both model and reasoning effort. A native-agent policy remains authoritative; stored overrides remain history but are not sent while locked.
2. Effort requires an explicit, discovered Codex model. With model `auto`, Cezar leaves the native Codex default untouched because it cannot safely infer compatible values.
3. The feature ships as one coherent release: typed API, persistence, YAML, CLI, runner mapping, and all existing engine-picker surfaces land together.

## 📝 Problem Statement

The cockpit discovers a host-local Codex model catalog but discards `supportedReasoningEfforts` and `defaultReasoningEffort`. Its public run inputs, persisted record, workflow schema, CLI, and runner seam carry only `model`; the Codex runner therefore sends no `effort` in `turn/start`.

Users can select a model but cannot deliberately make the latency/cost/reasoning-depth trade-off for a task. Native Codex configuration is not an adequate substitute because it is a broad hidden default instead of an explicit value attached to the run that used it.

## 📝 Proposed Solution

Normalize Codex's discovered reasoning capabilities into the existing model catalog and expose them through the typed contract. Add optional run and workflow-step `reasoningEffort` fields. The workflow manager resolves a step override before the run-level choice, passes the result through `AgentRunSpec`, and `CodexAppServerRunner` maps it to App Server's `turn/start.params.effort`.

The cockpit renders an **Effort** picker next to **Model**. `Codex default` omits the field; it is not a literal `auto` value. Changing runner or model clears the selection. New Task, approved plans, Inbox, GitHub handoff, and Continue use the same engine-picker state and request builders.

Codex documents the same split: clients discover `supportedReasoningEfforts` and `defaultReasoningEffort` through `model/list`, then may pass an override on `turn/start`, which becomes a default for later turns in the same thread. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 📝 Architecture

| Layer | Responsibility |
| --- | --- |
| `core/codex-model-catalog.ts` | Parse current App Server objects and legacy string effort lists, normalize and filter them. |
| `core/runner-model-catalog.ts` | Carry optional, backend-neutral picker metadata without inventing a cross-provider enum. |
| `packages/contract` | Own request, response, run-record, workflow, Continue, and Inbox-start Zod shapes. |
| `workflows/run.ts` | Validate the effective backend, resolve precedence, retain audit state, and pass a resolved value to a session. |
| `core/agent-runner.ts` | Add the optional backend-agnostic `reasoningEffort` transport field. |
| `core/codex-app-server-runner.ts` | Map the field to `turn/start.params.effort`, never to `thread/start`. |
| `packages/web` | Show only discovered Codex values and omit the field for `Codex default`. |

`reasoningEffort` is a string rather than a Cezar enum. The authenticated local App Server remains authoritative and can evolve independently. The browser offers only discovered values; API, CLI, and YAML stay pass-through so a stale catalog does not turn Cezar into a second model registry.

The narrow Codex scope is intentional. OpenCode also describes reasoning effort as an OpenAI/provider-specific model option rather than a universal agent parameter. [OpenCode agent options](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx) Cezar must not translate `high` into Claude thinking tokens or OpenCode options.

## 📝 Data Model and API Contract

### Catalog capability

Extend `ModelOption` and `runnerModelOptionSchema` with optional fields:

```ts
reasoningEfforts?: Array<{ id: string; description: string }>
defaultReasoningEffort?: string
```

`discoverCodexModels` supports both upstream shapes:

```ts
supportedReasoningEfforts: ["medium"]
supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "…" }]
```

It trims values, ignores blank/malformed entries, preserves first-occurrence order, and never lets malformed capability data hide an otherwise usable model. `defaultReasoningEffort` is display metadata only: Cezar never persists or automatically sends it.

### Run, continuation, inbox, and workflow fields

Add a shared bounded nonblank `reasoningEffort` schema to:

- `createRunInputBaseSchema` / `CreateRunInput`;
- `workflowStepDefSchema` in `packages/contract/src/workflows.ts` and the matching service schema in `src/workflows/types.ts`;
- public and persistent `runRecordSchema` / `RunRecord`;
- `stepStateSchema`, storing the resolved effort actually used by a session;
- `ContinueRunInput` and `StartTodoInput`, moved from `server.ts` to `packages/contract` before the field is added.

`RunRecord.reasoningEffort` and `StepState.reasoningEffort` are optional, preserving old `runs.json` and old YAML. `skillStackOf` treats a step effort override as non-portable richness, like per-step model or runner settings.

New-task absence means `Codex default`. Continue accepts `reasoningEffort: ""` as an explicit reset because it can replace a stored override; the UI emits that sentinel only when a user selects `Codex default` during Continue.

| Route / surface | Behavior |
| --- | --- |
| `POST /runs` | Accept and persist `reasoningEffort` through a contract-backed body. |
| `POST /runs/:id/continue` | Contract-backed override/reset; omission retains the current choice. |
| `POST /todos/:id/start` | Contract-backed effort alongside runner/model. |
| Workflow read/save/parse and inline plans | Round-trip `step.reasoningEffort`. |
| `cezar run --effort <level>` | Pass a per-run value through `StartRunInput`, with no CLI default. |

## 📝 Resolution, Validation, and Persistence

Resolve the effective runner before effort. Per agent step:

| Effective step | Resolved effort |
| --- | --- |
| Codex step with `step.reasoningEffort` | Step value. |
| Codex step without it, inheriting the task Codex runner | Run `reasoningEffort`. |
| Explicit Codex step in a mixed workflow whose task runner is non-Codex | No run-level inheritance; YAML may provide a step value. |
| Claude/OpenCode step | No effort is passed; a step-level value is a validation error. |

Therefore `workflow step.reasoningEffort > run.reasoningEffort > Codex native default`. A run-level value is rejected when it targets a non-Codex task runner or no agent step could inherit it. Mixed workflows may use effort only on Codex steps.

Entry points preflight and reject an explicit non-Codex effort where possible; `RunManager` repeats the validation before execution to protect queued, recovered, programmatic, and mixed-workflow paths. `modelsLocked` is enforced at entry and manager boundaries, strips both model and effort before persistence/spawn, and returns a policy error describing model and reasoning settings.

Continue on the same Codex runner inherits the latest resolved step value, then the run value, unless overridden/reset. Changing runner clears inherited effort; switching to a non-Codex runner with explicit effort rejects. The runtime records resolved effort before session start so recovery and later Continue remain reproducible.

## 📝 Codex App Server Mapping

Add `reasoningEffort?: string` to `AgentRunSpec`. Claude and OpenCode assert it is absent and report a clear unsupported-option error if a boundary is bypassed. Codex conditionally sends:

```ts
rpc.request('turn/start', {
  threadId,
  input,
  ...(spec.reasoningEffort ? { effort: spec.reasoningEffort } : {}),
  summary: reasoningSummary(),
})
```

The field never goes on `thread/start`, `thread/resume`, or `turn/steer`. `turn/steer` cannot accept turn-level overrides; later ordinary `turn/start` calls resend the session's resolved setting. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 📝 UX

| Condition | Effort control |
| --- | --- |
| Codex + explicit discovered model + capability | Enabled `Codex default` plus discovered values and descriptions. Server default is contextual text, not a Cezar selection. |
| Codex + model `auto` or custom/legacy model without capability | Hidden; compatibility is not guessed. |
| Catalog unavailable | Disabled with a concise hint; no override is generated. A nonempty stale cache remains usable and labelled as cached. |
| `modelsLocked` | Disabled/read-only with native-settings explanation; no override is generated. |
| Claude/OpenCode | Hidden. |

Update `NewTaskDraft`, draft normalization, `new-task-form`, `new-task-plan`, and `new-task.tsx`; runner/model changes clear effort and a new-task `Codex default` omits it. Extend shared `EnginePills` and `follow-up-engine` to cover Inbox, GitHub handoff, and Continue. No Settings control, `CEZ_*` variable, or `config.json` key is introduced.

## 📝 Edge Cases and Failure Modes

- Older App Server string arrays normalize; no capability removes the picker without preventing a native-default run.
- Catalog failures degrade like current model discovery; Cezar sends no override.
- A later App Server rejection of explicit API/YAML/CLI input remains the actionable session error.
- Old state parses as absent and resumes using native defaults.
- Non-Codex workflow steps never inherit a Codex setting; invalid step values fail visibly before a spawn.
- Locked native settings retain historic fields for audit but suppress them at execution.
- Rollback leaves optional JSON/YAML values harmless and needs no cleanup migration.

## 📝 Implementation Plan

1. Normalize model catalog capabilities and expose them through the typed contract.
2. Add contract-first effort shapes, workflow fields, optional persistence, and parity tests.
3. Implement precedence, native lock behavior, persistence, recovery, and continuation semantics.
4. Map the field solely through Codex `turn/start` with mock App Server assertions.
5. Wire typed HTTP routes, Inbox, Continue, and `cezar run --effort`.
6. Add a shared model-filtered picker to New Task, planned runs, Inbox, GitHub handoff, and Continue.
7. Complete catalog, contract, runtime, runner, CLI, and UI regression coverage; run the configured full gate.

## 📝 Architectural Review

The work is cohesive: one user choice must survive discovery, selection, validation, persistence, and Codex turn start. Splitting UI from persistence or CLI/YAML from runtime forwarding would create a setting that disappears or cannot be reproduced. Provider-neutral translation, global defaults, configuration migration, and non-Codex thinking controls remain out of scope.
