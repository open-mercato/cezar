# Automation review child stays off when Dispatch is off (#1742)

## Goal

A review-child instruction never reaches an automation's run when Dispatch is ineffective — off for the automation or off for the cockpit.

## Scope

- `packages/cezar/src/automations/task-template.ts`: the GitHub, schedule and tracker renderers append `REVIEW_CHILD_SUFFIX` only when cockpit dispatch is on (the same gate `startInput` already applies to `dispatchIntent`).
- `packages/web/src/routes/automations/editor-dispatch-row.tsx`: switching Dispatch off also switches Review child off, so re-enabling Dispatch does not restore it.

## Non-goals

- No automation schema change, no migration, no rejection of saved definitions.
- The first-enable default of Review child (`editor-draft.ts`) is unchanged — an open question on the issue.

## Implementation Plan

### Phase 1: Launcher

- 1.1 Gate the review-child suffix on `dispatchEnabled` in all three renderers, with tests for both paths.

### Phase 2: Editor

- 2.1 Dispatch off also turns Review child off, with a test.

## Risks

- Renderers are exported; the new `dispatchEnabled` argument defaults to off (the safe default, matching `launch*`'s `dispatchEnabled ?? false`).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Launcher

- [ ] 1.1 Gate the review-child suffix on dispatchEnabled in all three renderers

### Phase 2: Editor

- [ ] 2.1 Dispatch off also turns Review child off
