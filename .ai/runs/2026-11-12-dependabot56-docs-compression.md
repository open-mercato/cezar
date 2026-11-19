# Bound docs compression cleanup after client abort

## Goal

Remove Dependabot 56 / GHSA-vc2v-76pw-4v95 from the documentation site's installed dependency graph and prove native zlib cleanup when a client leaves during a compressed response.

Security-Source: open-mercato/cezar:dependabot:56
Security-Fingerprint: GHSA-vc2v-76pw-4v95:compression:docs/site/package-lock.json
Claim-Run: 0a8e4db2-1c8b-4171-924f-9bc5da2de5fd

## Scope

Only docs/site/package.json, docs/site/package-lock.json, a dedicated docs/site/scripts security test, and this plan. Use this linked worktree on fix/dependabot56-docs-compression, forked from discovered origin/main (261a32a81d46d0e9b1a4114e2f917d39f400c729). Keep the parent's adapter68 branch/lock/test changes separate.

## Implementation plan

### Phase 1: Scoped fix and regression

1. Verify current alert, PRs and automation claims; inspect upstream patch and parent constraints. Prefer a compatible parent update if it removes the vulnerability, otherwise use the explicitly authorized serve-only compression1.8.2 override.
2. Add a bounded loopback integration test for aborted gzip/deflate/Brotli responses and normal compressed-response controls. Capture real native zlib handle cleanup; demonstrate failure with original1.8.1 and success with1.8.2. Preserve serve and unrelated lock entries.

### Phase 2: Validation and review handoff

1. Prove installed path resolution and npm audit target removal; run docs checks/build and every ordered root validation command with bounded processes.
2. Refresh source/claim dedup checks, label the draft PR and publish exact evidence/limits. Transfer the retained atomic claim to the parent for the existing authoritative final reviewer. Keep draft; no final summary or release before review.

## Risks and non-goals

The direct parent serve14.2.6 pins compression1.8.1. The currently published serve14.2.7 also pins1.8.1, so a parent update alone is insufficient. A scoped npm override is authorized. No broad overrides, audit exceptions, npm audit fix --force, startup/API/env/settings/workflow changes, issues, advisories, merges, auto-merge or readiness promotion. No new task dispatch. No exploitability or fixed-on-main claim. Nonzero baseline failures remain visible and keep verification incomplete.

Evidence directory: /home/maintenance/cezar/projects/cezar/.ai/cezar/artifacts/2d5e629f-0ec5-4e40-8617-ba721909e978/docs-compression/
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Completed validation

Original compression1.8.1 fails all3native-abort cases with4passing controls; patched1.8.2 passes7/7. Parent independently repeated patched7/7 and resolved serve14.2.6 to compression1.8.2, all locked copies1.8.2, docs npm audit0vulnerable packages. Scoped override changes only compression among existing locked package versions; adds required destroy1.2.0 and npm-recorded6optional bundled WASM metadata rows.

Parent completed all root commands in order with timeout600, CEZ_INSTANCE_ID unset, TMPDIR=/tmp: typecheck; npmtest15372passed/8existing skips; core51; build/checkpack; package34. Also docs:check, docs:build and docs own typecheck allPASS. Child's two earlier continuation turns settled partial and interrupted background checks; those were not accepted as complete. Parent retained exact same claim and completed foreground verification in this isolated worktree. No source edits were needed after regression commit4e841542ed2f.

## Authoritative review and finalization

Independent code APPROVE, zero unresolved findings at21663bdf. Same original/patched test red3/7/green7/7, all5ordered root and all docs gates independently pass. Actual built-docs serve HTTP identity/gzip/HEAD pass; baseline offline npm normalization reproduces6optional bundled rows. [Review5880409525](https://github.com/open-mercato/cezar/pull/2144#pullrequestreview-5880409525) is COMMENTED because native own-bot approval was rejected; eligible external native approval remains required.

An unchanged coordinator timing test failed CI once. Local isolated test and exact shard5734/5734 pass; the same-head actual failed-job retry43284232462 attempt2 succeeded. The reviewer cleared its CI finding only after remote success; no source/assertion/workflow change or waiver. Reviewed head12CIchecksSUCCESS/2SKIPPED. Final plan-only commit can start pending checks; maintainers own the next check, no further monitoring promised. Parent finishes summary/readiness and original exact-SHA claim release, without merge/dismissal or main-fixed claim.

## Progress

PR: #2144

Claim-Lock: refs/om-locks/pr-2144
Claim-Lock-SHA: 2521bcc777b94ce5696e888f06b203dea17a55a3
Claim-Comment: 6832171683

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Scoped fix and regression

- [x] 1.1 Verify current alert and ownership; select the narrow dependency fix — c22f3056 (preflight/claim and upstream evidence in artifacts)
- [x] 1.2 Implement override and prove abort cleanup regression red/green — 4e841542ed2f

### Phase 2: Validation and review handoff

- [x] 2.1 Run installed-resolution, audit, docs and ordered root gates — 4e841542ed2f
- [x] 2.2 Publish labeled draft and transfer exact retained claim for review — 4e841542ed2f
