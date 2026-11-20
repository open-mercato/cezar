# Remove the mobile tooling vulnerable minimatch path

## Goal and scope
Remove Dependabot85 (GHSA-g3hv-75wg-m249) from packages/mobile/package-lock.json via compatible parent rimraf6.1.3→6.1.4, whose glob14 dependency uses patched minimatch11. Keep Capacitor versions/manifest constraints unchanged; no overrides. Confirm installed incoming paths and exercise real cleanup glob behavior and existing mobile coverage.

Security-Source: open-mercato/cezar:dependabot:85
Security-Fingerprint: GHSA-g3hv-75wg-m249:minimatch:packages/mobile/package-lock.json

Non-goals: docs/root/Cargo changes, native app/UI changes, issues, settings/workflows/descriptors, merge/auto-merge/release/dismissal. Separate branch/worktree and PR from Next group. Root runtime/workspace input files are identical to the first group; preserve shared ordered gate results with exact input binding and distinguish baseline failures. Mobile npm checks and runtime integration execute here. Native iOS/Android builds are not claimed on Linux.

## Implementation Plan
### Phase1
1.1 Upgrade only the compatible rimraf/glob/minimatch path and add real cleanup-glob compatibility coverage.
### Phase2
2.1 Run mobile check/test, CLI/runtime/resolution/security proof and the configured ordered root gate against identical root inputs; distinguish baseline failures.
### Phase3
3.1 Reuse final-review task for independent authoritative review; finalize draft/ready status, labels, evidence and exact owned lock release.

## Risks and decisions
Upstream rimraf6.1.4 still meets Capacitor CLI's^6.0.1 constraint; its glob major change requires runtime compatibility evidence. No direct dependency pin or override is necessary for a transitive compatible patch. Both user task slots are already used; no third task is created. The parent handles this independent lock patch in its own worktree and reuses the same final reviewer for both PRs after its own work is done.

After the explicit operator continuation following the ownership blocker, use the exact already-installed canonical atomic GitHub helpers as run-local tooling, with create-only refs and exact-SHA lease release. No repository descriptor/settings change or comment-only fallback. Inherit root run42bef4e9. Independent reviewer must assess this interpretation. This parent-created temporary worktree is removed on exit after all commits/pushes; its branch is retained.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Parent patch

- [ ] 1.1 Upgrade compatible parent and exercise cleanup-glob behavior

### Phase 2: Validation

- [ ] 2.1 Complete mobile and ordered root validation with removal proof

### Phase 3: Review and publication

- [ ] 3.1 Complete independent review, evidence, labels and exact owned lock release
