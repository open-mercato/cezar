# Execution plan — a runner switch must not inherit another runner's model

Telemetry: `43bdda11` (`gpt-5.6-luna`), `14b88647` (`gpt-5.6-terra`) — `claude: There's an issue with the selected model (gpt-5.6-*)`, 0.16.0, dispatch on.

## Goal

A child task or workflow step that runs on a different runner than the one its model was picked for never receives that model; it gets the new runner's default instead.

## Scope

- `RunManager.dispatchChild` (`packages/cezar/src/workflows/run.ts`): `runner: input.runner ?? intent.runner ?? parent.runner` but `model: input.model ?? intent.model ?? parent.model`. If a codex parent on `gpt-5.6-luna` dispatches `--runner claude` without `--model`, the child gets claude + `gpt-5.6-luna`, and Claude refuses it at spawn.
- `runAgentStep`: `step.model ?? input.model` under `step.runner ?? taskBackend`. A step that pins another runner inherits the task's model the same way.

## Non-goals

- Rejecting an EXPLICIT `--model` that mismatches `--runner` (the agent asked for it; the runtime identity gate stays the judge).
- Changing `continueRun` (it already clears a foreign inherited pin).

## Implementation Plan

### Phase 1: Fix inheritance

1.1 In dispatch, only inherit a model whose source runner matches the child's runner: `intent.model` belongs to `intent.runner ?? parent.runner`, `parent.model` to `parent.runner`.
1.2 In `runAgentStep`, inherit `input.model` only when the step's backend is the task backend.
1.3 Regression tests for both, each proven red without the fix.

## Risks

- A workflow that set `runner:` on a step and relied on the task-level model reaching it now gets that runner's default. It only worked when the task's model was valid on both runners, which is rare. Accepted; a step that needs a model should declare `model:`.

## Progress

PR: #1592

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix inheritance

- [x] 1.1 Dispatch inherits a model only from a source on the same runner — c408685c
- [x] 1.2 Workflow step inherits the task model only on the task's runner — c408685c
- [x] 1.3 Regression tests — c408685c
