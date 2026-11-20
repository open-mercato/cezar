# Security remediation #2331

Issue: https://github.com/open-mercato/cezar/issues/2331
Base: main at 7ac1b0c4b6ba7b36d3156016fbc96ee356708cb7
Claim-Run: 811669fd-e827-49aa-ae6f-a3173dfcf698
Claim-Comment: 7025545383
Claim-Lock-SHA: bb2731cf9e264aba47dd3aefa96db07f62601391

Triage: #2330 is merged; isolated homes are created but never removed. Open PR searches found no implementing PR. Complete issue/reset/atomic-lock checks passed before acquisition. Bot assignment endpoint returns 404; existing assignees preserved, in-progress verified.

— PREVIOUS STEP (om-root-cause) said —
Summary: Restricted Codex homes and their sensitive rollouts outlive permanently deleted task worktrees.

Root cause: prepareRestrictedCodexHome creates persistent account/cwd directories but no cleanup exists. RunStore already removes task-owned files on explicit deletion, archived expiry and index-cap pruning, and sweeps orphan task files at startup. Cwd absence alone is insufficient: retained tasks preserve session IDs and Continue restores the same path.

Files to change:
- packages/cezar/src/core/codex-restricted-home.ts — write an owner marker; conservative project-scoped cleanup with legacy config support and filesystem guards.
- packages/cezar/src/runs/store.ts — invoke cleanup through existing startup sweep and permanent task-file deletion paths.
- packages/cezar/src/core/codex-restricted-home.test.ts — cleanup, legacy, containment and retained-home guards.
- packages/cezar/src/runs/task-files.test.ts — integration coverage for deletion and startup, including reclaimed records.

Approach: Retain every indexed task, even when its worktree is absent. Prune only managed homes belonging to missing worktrees under this project's task directory whose task is gone. Read bounded regular metadata through no-follow descriptors; skip uncertain ownership, symlinked homes and other projects. Preserve native credentials and ordinary restricted preparation.

Risks: Cleanup is destructive. Reclaimed/native resume history, multiple accounts/projects, malformed indexes and older markerless homes require regression coverage. No API/config/env changes.

## Progress
- [x] Triage and atomic issue claim
- [x] Root-cause brief
- [x] Implementation and red/green proof — original source fails both integration regressions; cleanup suites pass 25 tests; full targeted resume suite passed 60 tests before added guards.
- [x] Five configured npm gates — typecheck;17,656 Vitest tests (8 skips);54 core tests; build/check:pack;35 package tests all pass on final code40144564a.
- [x] PR and code review — #2341; latest-code CI/CodeQL green, no remaining actionable findings. Automerge eligible; human QA still required. Claim release is recorded on the PR.

Status: automated implementation and validation complete. PR stays draft/needs-qa for required human lifecycle QA.
