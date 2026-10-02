# Fix issue #999: task temp and test environment isolation

## Goal

Keep task-scoped agent scratch directories outside the project checkout and keep
cockpit task variables out of this repository's zero-config test process, while
preserving the child-task reporting contract.

## Scope

- Relocate `agent-tmpdir` allocation, cleanup, and orphan recovery under the
  sandboxed per-user cezar home with project namespaces.
- Make Vitest use a safe temp root and clear only task-run variables from the
  test process.
- Update regression fixtures for the new allocation and retain dispatch env
  forwarding in `buildChildEnv`.

## Non-goals

- Do not remove `CEZ_*` from agent children.
- Do not change startup/index wiring or unrelated workflow attribution changes.

## Progress

> Convention: `- [ ]` pending, `- [x]` done.

### Phase 1: Isolation and regression coverage

- [x] 1.1 Relocate task scratch allocation and update cleanup fixtures — focused tests green
- [x] 1.2 Isolate Vitest temp and task environment defaults — contaminated suite green

### Phase 2: Verification

- [x] 2.1 Run the configured validation gate — typecheck, test, unit, build, package green
