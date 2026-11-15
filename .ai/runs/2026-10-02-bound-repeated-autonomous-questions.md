# Bound repeated autonomous questions

Goal: stop an autonomous run after two consecutive overridden structured questions, while preserving the sticky verbatim-repeat guard and resetting only the consecutive counter on every clean turn.

Scope: `packages/cezar/src/workflows/run.ts`, `packages/cezar/src/workflows/autonomous-nudge.test.ts`, and the dry-run mock fixture in `packages/cezar/scripts/mock-claude.mjs`.

Non-goals: change the ask marker schema, dispatch behavior, native ask handling, the autonomous safety cap, or unrelated runner behavior.

## Implementation plan

### Phase 1: diagnosis and guard

- [x] 1.1 Add the K=2 consecutive overridden-question state and apply it in both turn-end handlers. — da510660
- [x] 1.2 Add reworded-blocker and lifecycle dry-run fixtures with constant-based assertions. — 41d3df4

### Phase 2: verification and handoff

- [x] 2.1 Run targeted regression checks and the configured validation gate. — clean full gate passed; see final verification
- [x] 2.2 Review the diff, commit the final changes, and open the issue PR.

## Risks

The two hand-written turn-end handlers can diverge; the reset must run before DONE and monitoring branches, while the shared helper owns the bound and note. The existing `lastOverriddenAsk` remains sticky by design.

## Progress

PR: #1227

> Convention: `- [x]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: diagnosis and guard

- [x] 1.1 Add the K=2 consecutive overridden-question state and apply it in both turn-end handlers. — da510660
- [x] 1.2 Add reworded-blocker and lifecycle dry-run fixtures with constant-based assertions. — follow-up

### Phase 2: verification and handoff

- [x] 2.1 Run targeted regression checks and the configured validation gate. — clean full gate passed; see final verification
- [x] 2.2 Review the diff, commit the final changes, and open the issue PR. — PR #1227 follow-up


## Final verification

All configured commands passed. Clean full `npm test`: 507 files / 8590 tests passed. Test subprocesses removed inherited `CEZ_*` values and used `/tmp`; earlier environment/timing failures are superseded by this green run. Independent final review found no code defects on this implementation. Evidence: https://github.com/open-mercato/cezar/pull/1227#issuecomment-5944027729.
