# Fix stale run cancellation (#1087)

Goal: make cancellation terminal and slot-releasing even when startup or continuation never opens an agent session, without changing monitoring behavior.

Scope: `packages/cezar/src/workflows/run.ts` cancellation/ownership helpers and focused workflow tests.

Non-goals: monitoring wake/park behavior, recovery policy for non-cancelled runs, unrelated API/UI changes.

## Implementation Plan

### Phase 1: Reproduce and define ownership

- [x] 1.1 Add a regression test for cancelling an active pre-session run and prove it fails before the fix. — d7a28f1b
- [x] 1.2 Add state-ownership guards for asynchronous cleanup. — d7a28f1b

### Phase 2: Implement durable cancellation

- [x] 2.1 Persist terminal cancellation, settle running steps, release the active slot, and prevent late startup work from reviving the run. — d7a28f1b
- [x] 2.2 Run targeted cancellation tests and the configured validation gate. — fe22e1bb

### Dependency validation evidence (2026-09-27)

- Refreshed from released remote `de04e0c54b729f70babe45e4d751582325c143f5`; reused reviewed sidebar test commit `e882054b6300542f36583286e2e1804fcafd0598` unchanged (`f0700fdb`). Targeted sidebar test: 1 file, 3 tests passed (`/tmp/pr1098-fresh-targeted.log`).
- Sanitized sequential gate (`CEZ_*` unset, `TMPDIR=/tmp`): typecheck PASS; npm test 7947/7948 with one failure; unit 36/36 PASS; build PASS; package 16/16 PASS. Full log: `/tmp/pr1098-fresh-full-gate.log`.
- The remaining npm-test failure reproduces in isolation (5/6): `packages/cezar/src/workflows/autosave-gate.test.ts` expects autosave timer behavior but calls `RunManager.armAutosave` with undefined state (`run.ts:5452`, `TypeError: Cannot read properties of undefined (reading 'cwd')`). Isolation log: `/tmp/pr1098-isolated-autosave.log`. No lifecycle source changes were made by this dependency update.

## Risks

Cancellation is intentionally terminal before provider cooperation; late session teardown must not remove a newer owner or overwrite a later run state.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and define ownership

- [x] 1.1 Add a regression test for cancelling an active pre-session run and prove it fails before the fix. — d7a28f1b
- [x] 1.2 Add state-ownership guards for asynchronous cleanup. — d7a28f1b

### Phase 2: Implement durable cancellation

- [x] 2.1 Persist terminal cancellation, settle running steps, release the active slot, and prevent late startup work from reviving the run. — d7a28f1b
- [x] 2.2 Run targeted cancellation tests and the configured validation gate. — fe22e1bb
