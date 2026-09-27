# Fix automation lease reclaim race (#998)

## Goal

Make abandoned automation poll leases safe under competing processes, including crash
recovery and owner-safe release, without changing scheduler or server behavior.

## Scope

- `packages/cezar/src/automations/store.ts`
- `packages/cezar/src/automations/store.test.ts` and lease/concurrency fixtures if needed

Non-goals: workflow, scheduler, server, receipt semantics, or unrelated automation state changes.

## Implementation Plan

### Phase 1: Reproduce and design

- [x] 1.1 Add a deterministic competing-process regression test for abandoned lease reclaim — working tree
- [x] 1.2 Add tests for crash recovery, malformed locks, and owner-safe release — working tree

### Phase 2: Implement

- [x] 2.1 Replace the reclaim TOCTOU sequence with mutually exclusive ownership and fencing — working tree
- [x] 2.2 Preserve malformed/dead-lock fallback behavior and update lease tests — working tree

### Phase 3: Validate

- [ ] 3.1 Run targeted automation tests and the configured full validation gate
- [ ] 3.2 Review the diff and record limitations/evidence

## Risks

Lease persistence is a cross-process coordination seam; an incorrect reclaim can either
duplicate automation launches or strand polling. Tests must cover both live ownership and
recovery after a dead owner.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Reproduce and design

- [x] 1.1 Add a deterministic competing-process regression test for abandoned lease reclaim — a21f1865
- [x] 1.2 Add tests for crash recovery, malformed locks, and owner-safe release — a21f1865

### Phase 2: Implement

- [x] 2.1 Replace the reclaim TOCTOU sequence with mutually exclusive ownership and fencing — a21f1865
- [x] 2.2 Preserve malformed/dead-lock fallback behavior and update lease tests — a21f1865

### Phase 3: Validate

- [ ] 3.1 Run targeted automation tests and the configured full validation gate
- [x] 3.2 Review the diff and record limitations/evidence — pending review submission
