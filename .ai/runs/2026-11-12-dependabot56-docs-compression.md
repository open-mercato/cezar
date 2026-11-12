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

- [ ] 2.1 Run installed-resolution, audit, docs and ordered root gates
- [ ] 2.2 Publish labeled draft and transfer exact retained claim for review
