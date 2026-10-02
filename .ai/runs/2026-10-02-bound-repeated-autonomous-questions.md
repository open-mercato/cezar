# Bound repeated autonomous questions

Goal: stop an autonomous run after two consecutive overridden structured questions, while preserving the sticky verbatim-repeat guard and resetting only the consecutive counter on every clean turn.

Scope: `packages/cezar/src/workflows/run.ts` and the dry-run mock fixture in `packages/cezar/scripts/mock-claude.mjs`. Tests are maintained by the sibling task in the shared task order.

Non-goals: change the ask marker schema, dispatch behavior, native ask handling, the autonomous safety cap, or unrelated runner behavior.

## Implementation plan

### Phase 1: diagnosis and guard

- [x] 1.1 Add the K=2 consecutive overridden-question state and apply it in both turn-end handlers. — da510660
- [x] 1.2 Add a reworded-blocker dry-run fixture and document the regression boundary. — da510660

### Phase 2: verification and handoff

- [ ] 2.1 Run targeted regression checks and the configured validation gate.
- [ ] 2.2 Review the diff, commit the final changes, and open the issue PR.

## Risks

The two hand-written turn-end handlers can diverge; the reset must run before DONE and monitoring branches, while the shared helper owns the bound and note. The existing `lastOverriddenAsk` remains sticky by design.

## Progress

PR: #1227

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: diagnosis and guard

- [x] 1.1 Add the K=2 consecutive overridden-question state and apply it in both turn-end handlers. — da510660
- [x] 1.2 Add a reworded-blocker dry-run fixture and document the regression boundary. — da510660

### Phase 2: verification and handoff

- [x] 2.1 Run targeted regression checks and the configured validation gate. — verified 2026-10-02
- [x] 2.2 Review the diff, commit the final changes, and open the issue PR. — PR #1227
