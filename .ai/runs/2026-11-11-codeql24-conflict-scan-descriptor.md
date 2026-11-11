# Bind conflict-marker scan sizing to opened files

## Goal
Remediate open-mercato/cezar CodeQL alert24 (`js/file-system-race`) by binding conflict-marker size checks and reads to one descriptor.

## Scope
`packages/cezar/src/git-worktree.ts`, dedicated regression tests, and the required atomic-claim operation sections in `.ai/trackers/github.md` copied from the installed pipeline descriptor. One coupled security remediation group; implementation and regression proof stay together. Final independent review is the separate part. The prior read-only review used one of two child slots; reserve the remaining slot for implementation review.

Non-goals: dependency upgrades covered by PR1253 or blocked by Cargo; other alerts; GitHub settings/workflows; application settings/startup; public contracts; issue creation; merging, auto-merge, alert dismissal or releases.

## Implementation Plan
### Phase1: Restore mandatory claim support
1.1 Merge only missing atomic lock/reset operations from the installed tracker template; preserve all existing operations and gate settings. The user requested autonomous continuation without further confirmation. This is a repository descriptor compatibility extension, not a GitHub settings/workflow change.
### Phase2: Remediate the validated defect
2.1 Add deterministic pathname-replacement regression; demonstrate failure against original source; use one opened descriptor for sizing and content and close it on every exit. Preserve existing conflict guard behavior.
### Phase3: Verify and publish
3.1 Run targeted security/real-Git integration suites and all five ordered configured gates; record exact outcomes and residual limits.
3.2 Recheck alert identity, currentmain, PR duplicates and active claims; run authoritative PR review plus an independent dispatched review; keep draft if verification or required QA is incomplete.

## Risks
Git/worktree code is risk-high. Descriptor-only sizing does not prevent concurrent writes to the same inode. Preserve the2MB scan cap, skipped paths and fail-open unreadable-file behavior. Zero-config remains intact. No dependencies or CEZ_* changes.

## Sources and ownership
Security-Source: open-mercato/cezar:code-scanning:24
Source location: packages/cezar/src/git-worktree.ts:668 at main9cbdd8882b6be38936cb37e205d6fd26db2211fc.
Claim-Run: a5acebb9-0359-425d-a8dc-913ccbf920b8
Claim-Lock: refs/om-locks/pr-2091
Claim-Lock-SHA: d21539d15ba22e5c7df9a6f3e8887d3eaeda98c6

Existing PRs and four remediation automations checked; no candidate owner or remediation PR found. No issue created. Existing PR1253 foreign ownership preserved.

## Progress
PR: #2091

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Restore mandatory claim support
- [x] 1.1 Add missing atomic tracker operations — 9efed016

### Phase 2: Remediate the validated defect
- [ ] 2.1 Bind conflict-marker sizing and reads to one descriptor with regression proof

### Phase 3: Verify and publish
- [ ] 3.1 Run targeted and full validation
- [ ] 3.2 Complete independent review and publish verified PR

Claim audit: bot assignment POST returned403; explicit assignability GET returned404, confirming this bot cannot be assigned. Atomic ref and in-progress label verified; no assignee changed.
