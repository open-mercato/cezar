# #2349 terminal proc hardening — validation

Issue: https://github.com/open-mercato/cezar/issues/2349
Implementation: https://github.com/open-mercato/cezar/pull/2371
Spec: https://github.com/open-mercato/cezar/pull/2370
Review: https://github.com/open-mercato/cezar/pull/2371#pullrequestreview-6001200419
Implementation branch: `fix/issue-2349-terminal-proc`
Source commit: `afc46dd91358d696639aa0f5cdc96f9fee36e809`
Spec branch/head: `spec/issue-2349-linux-descendants` / `a5f8f3a91`
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Outcome
Linux terminal readers no longer execute ps or enumerate the global proc directory. They follow only cezar descendants using every thread's children list, without UID filtering. This retains elevated-child links and reachable ordinary-user grandchildren. Foreground remains asynchronous and cached; shutdown uses a Node helper under the old 1.5-second subprocess timeout with SIGKILL and an 8 MiB output cap, and validates JSON using Zod. Existing root/PPID guards, group exclusions and lifecycle signaling remain. macOS/Windows paths are unchanged.

The work is **not fully verified against native privilege/hidepid conditions**. All five local npm commands pass, with command-local CEZ_INSTANCE_ID isolation for npm test. Keep both PRs draft and omit automerge pending native QA/independent approval. Other all-user scanners named by maintainer triage are outside this terminal-only assignment and remain unchanged.

## Regression and runtime evidence
- `git stash push -- packages/cezar/src/server/terminal/foreground.ts packages/cezar/src/server/terminal/process-tree.ts`, then `timeout 30 npm test -- packages/cezar/src/server/terminal/linux-proc.test.ts -t 'production reader through'`: exit 1; **both** tests failed on actual legacy `ps -axo` calls. Helper and tests remained present. `git stash pop` restored the source; no stash remains from this work.
- `timeout 60 npm test -- packages/cezar/src/server/terminal/linux-proc.test.ts`: exit 0, 12/12 tests passed after restoration.
- `timeout 120 npm test -- packages/cezar/src/server/terminal`: exit 0, 14 files / 160 tests passed. Includes real PTY background/nohup/ignored-HUP shutdown, live ordinary child/grandchild independent groups and real bounded-helper execution. Synthetic fixtures cover non-leader threads, inaccessible cmdline/relationships, mixed/elevated ancestry, PID reuse, missing proc/kernel support, deadlines and malformed helper output.
- `timeout 30 strace -f -e trace=openat,getdents64,newfstatat,statx,execve ...` against both production readers: exit 0; foreground 2 rows, tree 3 rows, no ps execution and no `/proc` root enumeration. Numeric proc directories were the root and its descendants (3837739, 3837795, 3837845). Node also reads its own/system proc metadata. This is access-boundary evidence, not a privileged/hidepid test.
- Compiled `.js` shutdown helper smoke: exit 0, `{rows:2,containsSelf:true}`. The published path needs no tsx loader; source tests use the repo's installed loader.

## Full configured npm gate
The five commands were run in the configured order, each under a 600-second timeout. The initial no-dependencies attempt failed (127/127/1/127/1); `npm ci` then completed. Dependency files were unchanged.

| Command | First installed-dependency run | Latest evidence |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | Latest explicit source rerun exit 0. The second sequential attempt initially caught a test-only `TreeRow`/`ProcessRow` mismatch; it was corrected and rerun successfully. |
| `npm test` | exit 124 (600s bound); health-shape failure observed before implementation | Final sequential attempt exit 124 (600s); same inherited-environment failure reproduced. Command-local removal of CEZ_INSTANCE_ID makes that isolated test pass (0). Full normalized npm test exited 0 under the 1800s bound: 1093 files passed / 3 skipped; 17831 tests passed / 8 skipped, duration 875.90s. |
| `npm run test:unit` | exit 0, 54/54 | Final sequential attempt exit 0 (54/54). |
| `npm run build` | exit 0; check:pack passed | Final sequential attempt exit 0; check:pack passed. All CI checks on source head succeeded/skipped. |
| `npm run test:package` | exit 0, 35/35 | Final sequential attempt exit 0 (35/35). |

The inherited-environment test failure is `packages/cezar/src/server/projects-api.test.ts:1011`: its expected health key set omits `instanceId`, which server.ts:2093 includes when CEZ_INSTANCE_ID is inherited. `timeout 40 npm test -- packages/cezar/src/server/projects-api.test.ts -t 'keeps the protected shape'` exits 1 and shows that exact difference. It was observed before source changes. With only CEZ_INSTANCE_ID removed for the command, that isolated test passes (exit 0). No source or configuration fix is needed for this terminal PR; the earlier review suggestion to edit the health source/expectation is superseded by this evidence. The file was not edited. A timeout is incomplete verification, never a pass. All 14 CI checks on source afc46dd91 are success/skipped (12 success, 2 skipped), and all 11 workflow runs observed at that SHA are completed (2 success, 9 skipped). Full normalized local suite passed as above; its command was env -u CEZ_INSTANCE_ID timeout 1800 npm test. No application configuration was changed. Final results are posted on the PR and task report.

## Review, QA and merge gates
Review used the exact installed `om-auto-fix-issue` feature route: `om-auto-write-spec` → `om-spec-writing --autonomous` → `om-open-pr`; then `om-auto-implement-spec` → `om-auto-create-pr` → `om-open-pr` → `om-auto-review-pr --autofix` / `om-code-review`. No extra worker was spawned because the parent explicitly forbids it; spec cohesion and this code review are author self-review, not independent approval. The parent later reported independently inspecting afc46dd91 and running linux-proc.test.ts, linux-proc-real.test.ts, process-tree-real.test.ts and foreground.test.ts: 4 files / 28 tests passed in 5.96s. This is attributed parent evidence, not native setuid/hidepid QA or formal merge approval. Review found and corrected the load-bearing shutdown timeout before publication. No other actionable source finding was identified in the scoped diff.

Remaining verification status: **request changes / not approved** until native setuid/hidepid QA and independent approval. The earlier local npm-gate blocker was resolved by command-local environment isolation; all five configured npm commands now have passing results. GitHub rejected a formal changes-requested review by the PR's own author; the full report was submitted as a COMMENTED review instead. This is not an approval. `changes-requested` and `needs-qa` remain. No `qa-approved`, `qa-self-verified` or automerge was applied.

No actual privileged setuid fixture, hardened hidepid mount or non-Linux runtime test was run. If proc permissions deny relationship reads, or the kernel lacks children support, readers return unknown; the existing close warning and shell-group/binding shutdown fallback apply. Other process scanners remain. Manual QA instructions are on the PR. Required CI and QA approval still gate any merge; no further CI follow-up is promised by this run after handoff.

Automerge is omitted because privileged/hidepid QA and independent approval remain outstanding. The configured local npm gate now passes; parent explicitly directs a partial handoff and retains draft until native verification is complete. The diff changes no app startup/configuration/public architecture contract. The guarded `backport release/v0.20.x` label was applied because both original ps call sites are present on the newest release line. No release/base branch was pushed or merged.

## Ownership and artifacts
Atomic operations came from the inherited installed tracker descriptor; the descriptor and configuration are not in either PR. Run `3b137dce-0c30-43f0-a1f5-ec9378d2aec7` acquired issue ref SHA `922418d9da5bb252b5969dfe1498bfa325c4e8e5` (comment 7053717226). It acquired PR ref SHA `83f74fb63b3cc07474769c50081b59e4f14d6b44` (comment 7053960756) before withdrawing the issue claim and lease-deleting its exact ref. PR cleanup follows evidence publication: remove only owned label, mark original comment released, then delete only the expected PR SHA by lease. Tracker comments are the final cleanup audit. Bot assignment was explicitly forbidden (403); no assignee changed. No force claim or foreign lock release was attempted.

Full private command logs, red/green output, terminal output, syscall trace and compiled-helper smoke are copied to the task's cockpit Assets as `issue-2349-*` artifacts. They are execution evidence; this summary does not claim the incomplete full suite passed.


## Final command results
| Configured command | Final result |
| --- | --- |
| npm run typecheck | exit 0 after correcting a test-only row-type error caught by the preceding attempt (exit 1) |
| npm test | exit 0 with command-local CEZ_INSTANCE_ID removal; 17831 passed / 8 skipped in 875.90s; prior two 600s attempts exit 124 |
| npm run test:unit | exit 0; 54 passed |
| npm run build | exit 0, including check:pack |
| npm run test:package | exit 0; 35 passed |

Source code remains afc46dd91; the final commit adds only run/analysis evidence. No additional full rerun followed the parent's instruction to finish the current bounded run. Native setuid/hidepid and non-Linux runtime QA remain unperformed. Parent asked for a partial handoff; no formal author approval or merge readiness is claimed.
