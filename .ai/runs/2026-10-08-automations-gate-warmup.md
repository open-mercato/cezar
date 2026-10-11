# Replace automations gate warm-up sleeps with observable completion

## Goal

Resolve #930 by making `automations-gate.test.ts` wait for the server boot work it
asserts, rather than relying on a fixed macrotask delay. Preserve the opt-out gate,
the scheduler-start expectation, and the requirement that stale polls are re-baselined
before the scheduler starts.

## Scope

- `packages/cezar/src/server/automations-gate.test.ts`
- This run plan

## Non-goals

- No production scheduler or server changes.
- No changes to the active #1107 claim or its implementation.
- No broad test-suite timing changes.

## Implementation Plan

### Phase 1: Replace timing assumptions

- [ ] 1.1 Reproduce the delay-sensitive failures with a deterministic slow-git shim and record the baseline.
- [ ] 1.2 Replace fixed warm-up sleeps with observable completion and restore the re-baseline-before-scheduler ordering assertion.
- [ ] 1.3 Run focused regression tests, the configured validation gate, and report evidence.

## Risks

Test-only changes could accidentally make negative assertions pass before boot work
settles, or weaken the ordering contract. The tests will retain explicit observable
completion and ordering checks.

## Progress

PR: #1330

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Replace timing assumptions

- [x] 1.1 Reproduce the delay-sensitive failures with a deterministic slow-git shim and record the baseline. — 146821d7
- [x] 1.2 Replace fixed warm-up sleeps with observable completion and restore the re-baseline-before-scheduler ordering assertion. — 146821d7
- [x] 1.3 Run focused regression tests, the configured validation gate, and report evidence. — 3e2f9e37; independent review approved

## Verification

- Historical fixed-sleep implementation plus a 1-second `git` shim: 2 failed, 20 passed (scheduler start and re-baseline state).
- Current implementation plus the same shim: 22 passed; normal focused run: 22 passed.
- `npm run test:unit`: 42 passed.
- After isolated `npm ci`, package resolution points into this worktree; `npm run typecheck`: passed.
- Clean-temp scoped server rerun: 9 files, 243 passed; no failures.
- Two web diff suites fail both on this branch and `origin/main` when run in isolation (2 failures / 45 tests), confirming a baseline timing issue unrelated to this PR.
- Bounded clean full run (`npm test -- --maxWorkers=2`, `TMPDIR=/tmp TMP=/tmp TEMP=/tmp`, inherited API/bin/project/remote flags removed): 523 files passed, 1 skipped; 8,915 tests passed, 3 skipped, 0 failures.
- `npm run build`: passed, including contract inlining, web build, and `check:pack`.
- `npm run test:package`: 17 passed.

## Final orchestration verification

All configured gates pass with isolated worktree dependencies and the bounded clean-temp full suite. Independent source review approved; final documentation-only orchestration update removes stale completion notes. No implementation merged.
