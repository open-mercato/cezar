# Bound filesystem listing concurrency

Goal: resolve #1217 by running the existing per-entry filesystem probes through a fixed, order-preserving pool of 16 workers while preserving output, cap, containment, privacy, and omission semantics.

Scope: `packages/cezar/src/server/fs-browse.ts`, `packages/cezar/src/server/git-changes.ts`, one shared internal concurrency helper, and focused regression tests. No `server.ts` edits and no overlap with the unrelated diff/index work in #1184 or the subprocess work in #1206.

Non-goals: changing API shapes, symlink policy, privacy handling, candidate ordering, the 1000-entry cap, status/error behavior, or mutation-race semantics.

## Implementation plan

### Phase 1: baseline and helper

- [ ] 1.1 Record the focused baseline and add the issue-specific execution plan.
- [ ] 1.2 Add a small order-preserving worker-pool helper with a fixed concurrency limit and unit coverage.

### Phase 2: listing refactors

- [ ] 2.1 Refactor folder-picker entry resolution to the helper after slicing candidates, preserving dependent check order and omission behavior.
- [ ] 2.2 Refactor Files-tab file-size probes to the helper while retaining directory-first sorting and omitted sizes on stat failure.

### Phase 3: verification and handoff

- [x] 3.1 Add equivalence, cap-before-resolution, symlink/privacy, omission, ordering, empty-input, overlap, and max-16 regression coverage. — 9fb136a3
- [ ] 3.2 Run the configured validation gate, review the PR, and finalize the handoff. — blocked by baseline gate failures and GitHub self-review restriction

## Risks

Concurrent filesystem reads must not alter observable ordering or turn rejected/broken entries into new results. The helper must fail independently per entry so one stat failure preserves the existing omission semantics.

## Progress

PR: #1369

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: baseline and helper

- [x] 1.1 Record the focused baseline and add the issue-specific execution plan. — 4583b655
- [x] 1.2 Add a small order-preserving worker-pool helper with a fixed concurrency limit and unit coverage. — 202a23fa

### Phase 2: listing refactors

- [x] 2.1 Refactor folder-picker entry resolution to the helper after slicing candidates, preserving dependent check order and omission behavior. — 202a23fa
- [x] 2.2 Refactor Files-tab file-size probes to the helper while retaining directory-first sorting and omitted sizes on stat failure. — 202a23fa

### Phase 3: verification and handoff

- [x] 3.1 Add equivalence, cap-before-resolution, symlink/privacy, omission, ordering, empty-input, overlap, and max-16 regression coverage. — 57230670
- [ ] 3.2 Run the configured validation gate, review the PR, and finalize the handoff. — blocked by the unrelated baseline web failure and GitHub self-review restriction
