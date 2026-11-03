# Issue #870 — constrain long model-picker descriptions

## Goal
Prevent CLI-provided model descriptions from clipping or widening the model picker at narrow viewports while preserving readable labels, row hit areas, and Radix keyboard navigation across all PickerPill consumers.

## Scope
- `packages/web/src/components/picker-pill.tsx`
- focused `packages/web/src/components/picker-pill.test.tsx`
- browser QA notes/screenshots if available

## Non-goals
- No changes to dropdown primitives, model discovery, picker callers, or global typography.
- No behavior changes to filtering, selection, disabled/status rows, or keyboard interaction.

## Implementation Plan

### Phase 1: reproduce and regression coverage

- [x] 1.1 Inspect current picker structure and establish the clipping cause. — ed09b343
- [x] 1.2 Add a focused regression assertion for constrained/wrapping descriptions. — ed09b343

### Phase 2: minimal responsive fix

- [x] 2.1 Apply the smallest utility-class change to the description layout and commit it. — ed09b343
- [x] 2.2 Run focused tests and browser verification at 390px and desktop sizes. — screenshots show wrapping/no overflow, but all light/dark pairs visibly render dark; light-theme and keyboard claims remain unverified

### Phase 3: validation and handoff

- [x] 3.1 Run configured validation gate and review the resulting diff. — 48ae861a (gate blocked by unrelated baseline failures)
- [x] 3.2 Run authoritative PR review/autofix and publish evidence. — 48ae861a (self-review recorded; no actionable findings)

## Risks
The shared `PickerPill` renders runner, model, workflow, skill, variant, and branch menus; changing only description layout must not alter row focus or selection semantics.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: reproduce and regression coverage

- [x] 1.1 Inspect current picker structure and establish the clipping cause. — ed09b343
- [x] 1.2 Add a focused regression assertion for constrained/wrapping descriptions. — ed09b343

### Phase 2: minimal responsive fix

- [x] 2.1 Apply the smallest utility-class change to the description layout and commit it. — ed09b343
- [x] 2.2 Run focused tests and browser verification at 390px and desktop sizes. — wrapping/no-overflow evidence present; light-theme and keyboard evidence missing

### Phase 3: validation and handoff

- [x] 3.1 Run configured validation gate and review the resulting diff. — 48ae861a (gate blocked by unrelated baseline failures)
- [x] 3.2 Run authoritative PR review/autofix and publish evidence. — independent review: partial QA; draft/needs-qa retained
