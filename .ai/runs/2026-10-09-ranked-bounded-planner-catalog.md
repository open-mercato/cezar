# Bound the planner skill catalog

Goal: reduce planner prompt cost while preserving small catalogs, explicit skill mentions, all skill names, and deterministic ranking.

Scope: `packages/cezar/src/planner.ts` and its dedicated catalog tests. Non-goals: API shapes, skill discovery, runner behavior, response parsing, or unrelated tests.

## Implementation Plan

1. Measure the current catalog construction and verify issue #1213 has no existing implementation or active claim.
2. Add a pure bounded catalog builder with fixed defaults (6,000-character unchanged threshold, 15 described entries, 160-character descriptions), local relevance scoring, explicit-mention priority, and name-only tail.
3. Add regression tests for reduction, explicit mentions, unchanged byte identity, threshold, deterministic ranking, and empty catalogs.
4. Run targeted tests and the configured validation gate, review the PR, and report exact evidence.

Risks: prompt content changes only on catalogs over the documented threshold; ranking quality is intentionally heuristic and deterministic.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

- [x] 1. Measure current catalog construction and verify issue coverage
- [ ] 2. Implement bounded catalog builder
- [ ] 3. Add regression tests
- [ ] 4. Run validation, review, and report
