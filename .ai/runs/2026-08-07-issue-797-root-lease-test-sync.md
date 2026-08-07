# Fix the flaky repository-root lease timing assertion (#797)

## Goal

Make `packages/cezar/src/workflows/run-lease.test.ts` deterministic under full-suite load by replacing its
fixed wall-clock lease holder with explicit test synchronization, and make its teardown wait for
every spawned run to settle before the temporary fixture repository is removed — without
weakening the scheduling proof the file exists for.

## Context

`7cf03125` ("stop the repo-root lease from starving isolated runs", #438/#441) added
`run-lease.test.ts`. Its holder workflow is a single check step, `node -e "setTimeout(()=>{},1500)"`,
so the repository-root lease is held for a **fixed 1.5 s of wall-clock time**. The first test then
asserts `holder` is still `running` at the moment the isolated worktree run settles. That assertion
is only true while the holder's timer has not expired, so the test silently depends on the whole
sequence — two `git init` fixtures, a real `git worktree add`, three `RunManager` runs — completing
inside that window. Under the loaded full Vitest suite reported in #797 it took ~3.6 s, the holder
had already finished, and the assertion read `done` instead of `running`.

The same fixed duration causes the secondary failure. `afterEach` `rmSync`s the fixture root as
soon as the test body returns, but in the second test the `after` run settles the instant the
holder releases the lease, while the holder itself is still finalizing (`settleSuccess` → status
write → `dropActive`). The holder's trailing NDJSON event append then lands on a directory that no
longer exists → `ENOENT`.

Both are test-harness defects; `packages/cezar/src/workflows/run.ts` behaves correctly and is not touched.

## Scope

- `packages/cezar/src/workflows/run-lease.test.ts` only.

### Non-goals

- No change to `RunManager`, the lease implementation, or any production source file.
- No weakening, relaxing or deletion of the two scheduling assertions (`holder` still `running`
  when the isolated run finishes; a cancelled lease waiter frees the chain).
- No global Vitest configuration change (timeouts are set per test in this file).
- No changes to the sibling suites (`run-isolation.test.ts`, `workspace-semaphore.test.ts`).

## Implementation Plan

### Phase 1: Replace the fixed-duration holder with an explicit gate

The holder workflow becomes a check step that polls for a **release file** the test writes when it
deliberately wants the lease handed on, with a generous safety deadline so a broken test can never
hang the suite. Wall-clock timing stops being load-bearing: the holder is `running` because nothing
has released it yet, not because a timer has not fired. Both tests drive the release explicitly and
keep their assertions unchanged.

### Phase 2: Drain every spawned run before removing the fixture

Wrap fixture creation so every `startRun` id is tracked. `afterEach` then opens the gate (so a
failed assertion cannot leave a holder parked), waits for every tracked run to reach a settled
status, disposes the manager, and only then removes the temp repo. A run that refuses to settle is
cancelled and, if still stuck, reported loudly rather than silently swallowed.

### Phase 3: Prove stability

Repeated targeted runs of the file, a full-suite run (which is what exposed the flake), then the
complete configured validation gate.

## Risks

- **A gate file that is never released hangs the suite.** Mitigated by the holder's own safety
  deadline and by `afterEach` opening every gate before it waits.
- **Draining in `afterEach` could mask a genuinely stuck run.** Mitigated by bounding the drain,
  cancelling what is left, and failing the teardown when a run still will not settle.
- **The gate file sits inside the fixture repo.** It is written under `.ai/cezar/`, which no
  assertion and no `git` operation in these tests looks at, so it cannot perturb the worktree
  diff/review gate.

## Progress

PR: #800

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Replace the fixed-duration holder with an explicit gate

- [x] 1.1 Add a gate-file-driven holder workflow and release helper to the fixture — dedacffd
- [x] 1.2 Drive both tests off the explicit release instead of the 1.5 s timer — dedacffd

### Phase 2: Drain every spawned run before removing the fixture

- [x] Also landed: both tests now wait for the holder to actually own the lease before queueing
  behind it — `startRun` order never guaranteed it, so the lease could go to the short run and the
  first test would pass without exercising the slot hand-back at all — dedacffd
- [x] 2.1 Track every started run per fixture — dedacffd
- [x] 2.2 Open the gate, drain to settled and dispose the manager before `rmSync` — dedacffd

### Phase 3: Prove stability

- [x] Post-review fix: POSIX single-quote escaping for the gate path handed to `bash -lc`, and
  `manager.dispose()` moved into a `finally` so a failed drain cannot leak the usage-sampler
  subscription — d33e91e8
- [x] 3.1 Repeated targeted runs plus a full-suite run — 6× targeted (all green, ~0.9 s of test time
  each, down from ~3 s of sleeping) and 3× `npm test` (303 files / 5407 tests, green each time). The
  proof was also checked negatively: with the #438 slot hand-back reverted locally, the first test
  fails on the isolated run starving.
- [x] 3.2 Full validation gate — `npm run typecheck` ✅, `npm test` ✅ (5407 passed), `npm run
  test:unit` ✅ (36 passed), `npm run build` ✅ (`check:pack ok — 459 files`), `npm run test:package`
  ✅ (12 passed).
