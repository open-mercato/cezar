# Dispatch settings: the Subtask model list must follow the subtask runner

Engine: om-auto-create-pr (steps: 3, --loop: no)

## Goal

In the composer's Dispatch settings, picking a subtask runner that differs from the parent's
(Codex under a Claude parent) must offer that runner's own models instead of "same as parent"
alone.

## Context

`DispatchSettings` builds the model list from `modelsFor(subtaskRunner)`
(`packages/web/src/components/dispatch-toggle.tsx:265-266`). The composer supplies that callback
as `(id) => (id === displayRunner ? models : modelsForRunner(id))`
(`packages/web/src/routes/new-task.tsx:790`): the **parent's** runner gets the live host catalog,
every other runner gets only the static presets from `MODELS_BY_RUNNER`. Codex, OpenCode, Cursor
and Junie list `auto` (`id: ''`) alone there — deliberately, since #784/#794 moved them to
discovery — and the select filters `id: ''` out because its own empty option already means
"same as parent". The list therefore collapses to a single option for exactly the runners that
discover their models.

The rest of the cockpit already applies the opposite rule: `useContinueAction`
(`routes/task-thread/follow-up-engine.tsx:66`) and `engine-pills.tsx:81,259` each fetch the
catalog of the runner **the user picked**, enabled only when that surface can use it. The
dispatch popover is the one place that did not.

## Scope

- `packages/web/src/components/dispatch-toggle.tsx` — fetch the selected subtask runner's catalog
  and build the model list from it.
- `packages/web/src/routes/new-task.tsx` — pass the parent's already-fetched catalog in, instead
  of a per-runner callback that can only answer for the parent.
- `packages/web/src/routes/new-task.test.tsx` — cover a Codex subtask under a Claude parent.

## Non-goals

- The server/engine side of `dispatch.model` (it already carries the id through
  `dispatchIntentSchema`).
- The automations editor's separate dispatch row (`routes/automations/editor-dispatch-row.tsx`),
  which has no runner/model controls.
- Adding static model presets back to the discovering runners — #784/#794 removed them on purpose.
- Prefetching every runner's catalog (`useRunnerModelCatalogs`): only the runner actually selected
  is fetched.

## Implementation Plan

### Phase 1: Follow the subtask runner's catalog

1.1 In `DispatchToggle`, resolve the effective subtask runner from the intent it already holds
(`value ?? remembered`, so the list is right even while the toggle is off) and call
`useRunnerModels(subtaskRunner, available && subtaskRunner !== parentRunner)`. Replace the
`modelsFor` prop with `parentModels`, and hand `DispatchSettings` the finished list — the parent's
live catalog when the subtask inherits the runner, the subtask runner's own otherwise.

1.2 Extend the Dispatch popover tests: with Claude as parent and Codex picked as the subtask
runner, "Subtask model" offers Codex's discovered models and a pick rides the POST body; the
inherited case still shows the parent's catalog.

### Phase 2: Validate

2.1 Run the full `validation.commands` gate.

## Risks

- One extra `GET /api/v1/models` request when the user picks a non-parent subtask runner. Bounded:
  only fires while the chevron has been opened and a different runner is actually selected, and
  react-query caches it for 5 minutes per runner — the same request the composer's own runner pill
  would make.
- A runner with no host catalog (`pi`, `copilot`) still falls back to its static presets, which is
  the existing, intended behavior.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Follow the subtask runner's catalog

- [ ] 1.1 Fetch the selected subtask runner's catalog in DispatchToggle
- [ ] 1.2 Cover a Codex subtask under a Claude parent in the popover tests

### Phase 2: Validate

- [ ] 2.1 Run the full validation gate
