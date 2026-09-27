# Fix Pi message item identities

Goal: ensure distinct assistant messages in one Pi turn produce distinct v2 item ids while preserving v1 and bounded adapter state.

Scope: `packages/cezar/src/core/pi-ui-mapper.ts`, its Pi tests, and the Pi lifecycle fixture.

Non-goals: changes to the shared protocol, server/workflow code, or other backends.

## Implementation Plan

### Phase 1: Reproduce and fix

- [x] 1.1 Confirm the reported collision and add a failing regression test — 11e7b8b2
- [x] 1.2 Add adapter-local per-message identity and bounded turn bookkeeping — 11e7b8b2
- [x] 1.3 Update Pi golden fixture and run targeted tests — 11e7b8b2, 37dd0416

### Phase 2: Validate and publish

- [x] 2.1 Run the configured validation gate — typecheck/build/unit/package green; sanitized full npm test is 7949/7950 with one base-reproduced automation-gate failure; sidebar dependency validated separately
- [ ] 2.2 Commit, push, open and review the PR

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — `<commit sha>` when a step lands.

### Phase 1: Reproduce and fix

- [x] 1.1 Confirm the reported collision and add a failing regression test — 11e7b8b2
- [x] 1.2 Add adapter-local per-message identity and bounded turn bookkeeping — 11e7b8b2
- [x] 1.3 Update Pi golden fixture and run targeted tests — 11e7b8b2

### Phase 2: Validate and publish

- [x] 2.1 Run the configured validation gate — typecheck/build/unit/package green; full npm test is 7949/7950 with one unrelated automation-gate timing failure; sidebar dependency validated separately
- [ ] 2.2 Commit, push, open and review the PR

### Dependency validation evidence (2026-09-27)

- Reused reviewed sidebar test commit `e882054b6300542f36583286e2e1804fcafd0598` unchanged; targeted `packages/web/src/routes/cross-project-task-navigation.test.tsx`: 1 file, 3 tests passed.
- Sanitized gate (`CEZ_*` unset, `TMPDIR=/tmp`): `npm run typecheck` PASS; `npm test` 7949 passed / 1 failed; `npm run test:unit` PASS (36/36); `npm run build` PASS; `npm run test:package` PASS (16/16).
- The npm-test failure is an unrelated existing timing/environment failure: `src/server/automations-gate.test.ts` background scheduler expects `start` once but observed zero. Full log: `/tmp/pr1101-full-gate.log`.
