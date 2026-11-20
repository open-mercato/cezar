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

PR: #2365

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Parent patch

- [x] 1.1 Upgrade compatible parent and exercise cleanup-glob behavior — a87c31511

### Phase 2: Validation

- [ ] 2.1 Complete mobile and ordered root validation with removal proof

### Phase 3: Review and publication

- [ ] 3.1 Complete independent review, evidence, labels and exact owned lock release

## Verification so far
Installed pre-upgrade path is CLI8.6.0→rimraf6.1.3→glob13.0.6→minimatch10.2.6. After parent patch: CLIunchanged→rimraf6.1.4→glob14.0.6→minimatch11.0.9; incoming ranges accept every step. Only required six transitive lock entries change, no override/direct manifest change. Mobile checkPASS;149testsPASS including2real parent cleanup-glob controls;CLIversion/helpPASS;npmlsPASS;audit0vulnerabilities. Independent npm-semver comparison proves old version in alert85 range and installed/alllocked new copies outside it. No native iOS/Android build claim.

Shared root workspace source/config inputs are identical to the Next group and main; full gate first attempt in order:typecheckPASS,npmtesttimeout900s with known pre-existing automationrace(PR2193),coreunit54PASS,build/checkpackPASS,packagePASS. No full gate pass claimed; Phase2 stays unchecked pending bounded full revalidation by final reviewer. No source change or gate/audit bypass for the unrelated defect.
