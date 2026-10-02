# Bound repeated autonomous questions

Goal: stop an autonomous run after two consecutive overridden structured questions, while preserving the sticky verbatim-repeat guard and resetting only the consecutive counter on every clean turn.

Scope: `packages/cezar/src/workflows/run.ts`, `packages/cezar/src/workflows/autonomous-nudge.test.ts`, and the dry-run mock fixture in `packages/cezar/scripts/mock-claude.mjs`.

Non-goals: change the ask marker schema, dispatch behavior, native ask handling, the autonomous safety cap, or unrelated runner behavior.

## Implementation plan

### Phase 1: diagnosis and guard

- [x] 1.1 Add the K=2 consecutive overridden-question state and apply it in both turn-end handlers. — da510660
- [x] 1.2 Add reworded-blocker and lifecycle dry-run fixtures with constant-based assertions. — follow-up pending commit

### Phase 2: verification and handoff

- [x] 2.1 Run targeted regression checks and the configured validation gate. — focused gate green; full npm test blocked
- [ ] 2.2 Review the diff, commit the final changes, and open the issue PR.

## Risks

The two hand-written turn-end handlers can diverge; the reset must run before DONE and monitoring branches, while the shared helper owns the bound and note. The existing `lastOverriddenAsk` remains sticky by design.

## Progress

PR: #1227

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: diagnosis and guard

- [x] 1.1 Add the K=2 consecutive overridden-question state and apply it in both turn-end handlers. — da510660
- [x] 1.2 Add reworded-blocker and lifecycle dry-run fixtures with constant-based assertions. — follow-up

### Phase 2: verification and handoff

- [x] 2.1 Run targeted regression checks and the configured validation gate. — focused gate green; full npm test blocked
- [x] 2.2 Review the diff, commit the final changes, and open the issue PR. — PR #1227 follow-up

## Validation limits

The focused autonomous regression suite passes, including reworded K=2, clean-turn/sticky-repeat, monitoring wake reset, and continuation coverage. `npm run typecheck`, `npm run test:unit`, `npm run build`, and `npm run test:package` passed. The configured `npm test` gate is not green: it reports failures in unrelated workspace/git/route/health/automation/account suites. A negative control with this branch's scoped files stashed reproduces the health failure: `projects-api.test.ts` expects `repo: null` for a temporary directory but receives the outer repository metadata (`/home/cezar/cezar`, branch `docs/readme-header`), confirming test-environment root contamination rather than this workflow change.
