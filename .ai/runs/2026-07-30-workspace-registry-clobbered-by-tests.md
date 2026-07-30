# Workspace registry clobbered by the test suite

## Goal

Stop a cezar test run from overwriting the developer's real `~/.cezar/config.json`, so the project registry survives both the validation gate and an app restart.

## Scope

- Resolve the workspace config path once per merge-write and use that same path for the read and the write.
- Refuse, under vitest, any write that lands inside the real `~/.cezar`, so a test that loses its `CEZ_HOME` pin fails loudly instead of silently rewriting a developer's registry.
- Pin `CEZ_HOME` for the whole server suite from a setup file, so a per-file `afterEach` that deletes the variable cannot leave a later write unpinned.
- Keep a last-known-good copy of a non-empty registry next to it and restore from that copy when the config file is missing, empty, or corrupt.
- Cover all of it with regression tests, including one that runs a timing-out suite in a nested vitest and asserts the home registry is untouched.

## Non-goals

- Do not change the registry schema, the migration cursor, or the `~/.cezar` layout.
- Do not rewrite the 24 test files that pin `CEZ_HOME` through `process.env`; the setup-file pin and the write guard protect them as they are.
- Do not add configuration: the backup file and the guard are automatic and have no knobs (zero config).
- Do not touch the failing suites unrelated to this bug.

## Background

`mergeWriteWorkspaceConfig` reads through `loadWorkspaceConfig()`, which resolves `workspaceConfigPath()` at call time, and then writes to a *second, independently resolved* `workspaceConfigPath()` — after the `await`. `cezarHomeDir()` reads `process.env.CEZ_HOME` on every call, so when a test's `afterEach` deletes the pin while a registration is still in flight (a timing-out test is enough), the read comes from the temp home and the write lands on the developer's real `~/.cezar/config.json` — replacing the whole registry with the test fixture's projects.

## Implementation Plan

### Phase 1: One path per merge-write, and a sandbox guard

1. Give `loadWorkspaceConfig` an optional path argument and resolve the path once in `mergeWriteWorkspaceConfig`, so the read and the write can never disagree.
2. Add a home-write guard that throws when a vitest process writes into the real `~/.cezar`, and wire it into the workspace writers.
3. Cover both with unit tests.

### Phase 2: Keep the suite pinned

4. Pin `CEZ_HOME` to a per-file temp home from a vitest setup file, and restore the pin after every test.
5. Adjust the tests that deliberately assert the unpinned default.

### Phase 3: Registry backup and self-heal

6. Write a `config.json.bak` snapshot after every successful merge-write that leaves a non-empty registry.
7. Restore from that snapshot in `loadWorkspaceConfig` when the config file is missing, empty, or corrupt.
8. Cover the backup and the restore with unit tests.

### Phase 4: Regression proof and docs

9. Add the in-process regression test: a merge-write that loses its pin mid-flight still writes to the pinned home and never touches the real one.
10. Add the nested-vitest regression test: a timing-out suite that uses the old pin/unpin pattern leaves the home registry untouched.
11. Document the guard and the backup file (AGENTS.md, CHANGELOG).

## Risks

- The setup-file pin changes the default environment for every server test; a test that implicitly relied on an unpinned `CEZ_HOME` has to opt out explicitly (Phase 2 step 5 handles the known ones, the gate catches the rest).
- The restore-from-backup path makes `rm ~/.cezar/config.json` no longer a full reset while `config.json.bak` exists; documented, and removing the cezar home still resets everything.
- The nested-vitest regression test spawns a second vitest and costs a few seconds in the fast unit gate; it is one fixture file with a short timeout.

## Progress

PR: #731

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: One path per merge-write, and a sandbox guard

- [x] 1.1 Resolve the workspace config path once per merge-write — e2817299
- [x] 1.2 Refuse vitest writes into the real `~/.cezar` — e2817299
- [x] 1.3 Unit-test the frozen path and the guard — e2817299

### Phase 2: Keep the suite pinned

- [x] 2.1 Pin `CEZ_HOME` from a vitest setup file — 4ec1552c
- [x] 2.2 Opt out the tests that assert the unpinned default — 4ec1552c

### Phase 3: Registry backup and self-heal

- [x] 3.1 Snapshot a non-empty registry to `config.json.bak` — 613a187d
- [x] 3.2 Restore from the snapshot when the config is missing, empty, or corrupt — 613a187d
- [x] 3.3 Unit-test the backup and the restore — 613a187d

### Phase 4: Regression proof and docs

- [x] 4.1 In-process regression test for a mid-flight unpin — 9a2227ea
- [x] 4.2 Nested-vitest regression test for a timing-out suite — 9a2227ea
- [x] 4.3 Document the guard and the backup file — 9a2227ea
