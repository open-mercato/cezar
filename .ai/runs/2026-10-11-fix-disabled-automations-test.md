# Fix disabled automations route test determinism

## Goal

Make the disabled-automations route assertions deterministic when the lazy route module is cold or the test runner is contended, while preserving assertions that the real rendered placeholder text is present.

## Scope

- `packages/web/src/routes.test.tsx`
- No application component changes.

## Implementation Plan

### Phase 1: Regression test fix

- [ ] 1.1 Establish a red reproduction by removing the lazy-module preload and running the focused test under contention.
- [ ] 1.2 Preload the real automations route module before the assertions and verify the focused test remains strict about both placeholder texts.

## Risks

The test-only preload must not replace the production lazy boundary or weaken the rendering assertions. The focused test and full configured validation gate will be run before completion.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Regression test fix

- [ ] 1.1 Establish a red reproduction by removing the lazy-module preload and running the focused test under contention.
- [ ] 1.2 Preload the real automations route module before the assertions and verify the focused test remains strict about both placeholder texts.
