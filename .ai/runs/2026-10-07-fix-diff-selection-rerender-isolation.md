# Fix diff selection rerender isolation

## Goal

Scope line-range drag selection to the dragged diff file so unrelated files do not rerender or rebuild their marks map, while preserving unified/split range comments.

## Scope

- `packages/web/src/components/diff/line-comments.tsx`
- `packages/web/src/components/diff/diff-view.tsx`
- Dedicated diff component regression tests

Non-goals: server/API changes, attachment/composer flow, or changes to saved comment persistence.

## Implementation Plan

### Phase 1: Diagnose and isolate live selection state

- [x] 1.1 Add a per-file selection context and move drag state/handlers out of the shared comments context. — 23be7f5c
- [x] 1.2 Update unified and split row consumers to use scoped selection state without changing range semantics. — 23be7f5c

### Phase 2: Regression coverage and verification

- [x] 2.1 Add a render-count regression covering an unrelated file during drag selection. — b66ecbf0
- [x] 2.2 Run targeted and configured validation, review the PR, and capture UI evidence where available. — b905d314

Outcome: implementation, red/green regression proof, independent code review, full CI, and disposable-fixture browser QA are complete at PR head `ccc2fa4bb9946a74b8a5de3337b613ea1d69551c`. QA evidence covers unified range save, split persistence, unrelated-file marks isolation, and cancel behavior; the PR remains guarded by `needs-qa` pending the formal merge gate.

## Risks

The selection provider must remain mounted with each file body so virtualization does not change editor behavior; unified and split rows must continue to share the same per-file line ordering.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — `<commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Diagnose and isolate live selection state

- [x] 1.1 Add a per-file selection context and move drag state/handlers out of the shared comments context. — 23be7f5c
- [x] 1.2 Update unified and split row consumers to use scoped selection state without changing range semantics. — 23be7f5c

### Phase 2: Regression coverage and verification

- [x] 2.1 Add a render-count regression covering an unrelated file during drag selection. — b66ecbf0
- [x] 2.2 Run targeted and configured validation, review the PR, and capture UI evidence where available. — b905d314
