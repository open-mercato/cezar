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
PR: #1345

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

- [x] 1. Measure current catalog construction and verify issue coverage — 850ef664
- [x] 2. Implement bounded catalog builder
- [x] 3. Add regression tests
- [x] 4. Run validation, review, and report — review performed locally; GitHub self-review prohibited

## Independent review and final handoff

[Final independent review](https://github.com/open-mercato/cezar/pull/1345#issuecomment-6072578744) approved source head `575788b933de2617f8035d523fe99198ebecfbde` with no findings. GitHub rejected formal approval because the authenticated account authored this PR. This finalization commit changes this plan only; reviewed source is unchanged. No merge was performed.

Clean local full gate passed. GitHub CI encountered the known abandoned-lock race tracked by #1117 (automation store, outside this diff); failed jobs were rerun. CI success is not assumed and remains a merge gate.
