# Run plan: issue-540-reference-candidates

Goal: bound the run-reference janitor's per-event candidate work while preserving marker precedence and old `runs.json` compatibility.

Scope: `packages/cezar/src/runs/store.ts`, its focused tests, and task-marker tests only. The optimization is limited to recognizing when the referenced PR candidate set is permanently capped/ambiguous, alongside the existing issue-side settled guard.

Non-goals: dispatch indexing methods or tests, UI/API changes, schema migrations, unrelated event parsing or reference-resolution behavior.

## Implementation Plan

### Phase 1: Baseline and regression coverage

- [x] 1.1 Confirm the current reference janitor behavior and add failing regression tests for marker precedence, candidate persistence/legacy records, and the issue cap. — bf2f3d30 + implementation commit
- [x] 1.2 Prove the focused cap regression fails with the source optimization absent. — red: old guard called `trackReferencedPrs` after both caps

### Phase 2: Bounded reference tracking

- [x] 2.1 Add the minimal settled-state guard for capped PR/issue candidate tracking and preserve the issue-number seed exception. — implementation commit
- [x] 2.2 Run focused tests, the configured validation gate, and review the final diff for scope. — focused 172/172; typecheck/unit/build/package green; full npm test has 13 unrelated failures

Risks: the janitor must continue scanning until marker-driven resolution and issue-number seeding are no longer possible; an over-broad early return could lose a later authoritative marker or seed.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Baseline and regression coverage

- [x] 1.1 Confirm the current reference janitor behavior and add failing regression tests for marker precedence, candidate persistence/legacy records, and the issue cap. — bf2f3d30 + 287ab4ef
- [x] 1.2 Prove the focused cap regression fails with the source optimization absent. — red: old guard called `trackReferencedPrs` after both caps

### Phase 2: Bounded reference tracking

- [x] 2.1 Add the minimal settled-state guard for capped PR/issue candidate tracking and preserve the issue-number seed exception. — 287ab4ef
- [ ] 2.2 Run focused tests, the configured validation gate, and review the final diff for scope. — tests complete; full npm test has 13 unrelated failures; formal self-review blocked by GitHub
