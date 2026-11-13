# Bind conflict-marker scan sizing to opened files

## Goal
Remediate open-mercato/cezar CodeQL alert 24 (`js/file-system-race`) by binding conflict-marker size checks and reads to one descriptor.

## Scope
`packages/cezar/src/git-worktree.ts`, dedicated regression tests, the Codex signal-test setup correction needed to pass the validation gate, and the required atomic-claim operation sections in `.ai/trackers/github.md` copied from the installed pipeline descriptor. One coupled security remediation group; implementation and regression proof stay together. Final independent review is the separate part. The prior read-only review used one of two child slots; reserve the remaining slot for implementation review.

Non-goals: dependency upgrades covered by PR #1253 or blocked by Cargo; other alerts; GitHub settings/workflows; application settings/startup; public contracts; issue creation; merging, auto-merge, alert dismissal or releases.

## Implementation Plan
### Phase 1: Restore mandatory claim support
1.1 Merge only missing atomic lock/reset operations from the installed tracker template; preserve all existing operations and gate settings. The user requested autonomous continuation without further confirmation. This is a repository descriptor compatibility extension, not a GitHub settings/workflow change.
### Phase 2: Remediate the validated defect
2.1 Add deterministic pathname-replacement regression; demonstrate failure against original source; use one opened descriptor for sizing and content and close it on every exit. Preserve existing conflict guard behavior.
2.2 Correct an existing SIGTERM test setup race observed in a complete suite and a four-worker rerun: record the signal after session startup, just before child termination. Preserve assertions and production signal handling.
### Phase 3: Verify and publish
3.1 Run targeted security/real-Git integration suites and all five ordered configured gates; record exact outcomes and residual limits.
3.2 Recheck alert identity, currentmain, PR duplicates and active claims; run the authoritative PR review through an independent dispatched review; keep draft if verification or required QA is incomplete.

## Risks
Git/worktree code is risk-high. Descriptor-only sizing does not prevent concurrent writes to the same inode. Preserve the 2 MB scan cap, skipped paths and fail-open unreadable-file behavior. Zero-config remains intact. No dependencies or CEZ_* changes.

## Sources and ownership
Security-Source: open-mercato/cezar:code-scanning:24
Source location: packages/cezar/src/git-worktree.ts:668 at main 9cbdd8882b6be38936cb37e205d6fd26db2211fc.
Claim-Run: a5acebb9-0359-425d-a8dc-913ccbf920b8
Claim-Lock: refs/om-locks/pr-2091
Claim-Lock-SHA: d21539d15ba22e5c7df9a6f3e8887d3eaeda98c6

Existing PRs and four remediation automations checked; no candidate owner or remediation PR found. No issue created. Existing PR #1253 foreign ownership preserved.

## Progress
PR: #2091

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Restore mandatory claim support
- [x] 1.1 Add missing atomic tracker operations — 9efed016

### Phase 2: Remediate the validated defect
- [x] 2.1 Bind conflict-marker sizing and reads to one descriptor with regression proof — bb720d7f72ff6e5350afcd783d9f07d1b0520b5c
- [x] 2.2 Record the SIGTERM fixture signal after session startup — 11c0e5532a0c3ca528cbdf61218ac0f2d8d00a9b

### Phase 3: Verify and publish
- [x] 3.1 Run targeted and full validation — 11c0e5532a0c3ca528cbdf61218ac0f2d8d00a9b
- [x] 3.2 Complete independent review and publish verified PR — cbbfb7db7101c520e80265fe518fb5e1bc085989

Claim audit: bot assignment POST returned 403; explicit assignability GET returned 404, confirming this bot cannot be assigned. Atomic ref and in-progress label verified; no assignee changed.

## Verification evidence (rolling)
- Before implementation: `timeout 120 npm test -- packages/cezar/src/git-worktree-conflict-file-identity.test.ts` against unchanged source: six failed, one passed. Two behavioral failures demonstrate oversized replacement consumption and hidden conflict markers; four assert closure on existing descriptor paths.
- After fix: `timeout 120 npm test -- packages/cezar/src/git-worktree-conflict-file-identity.test.ts packages/cezar/src/autosave-conflict-guard.test.ts packages/cezar/src/workflows/autosave-gate.test.ts`: 27 passed. Existing suites use real Git repositories/merges to verify that autosave refuses unresolved/staged conflict markers and commits after genuine resolution.
- `timeout 600 env -u CEZ_INSTANCE_ID npm run typecheck`: passed.
- Initial full `npm test` inherited TMPDIR under real `~/.cezar` and failed the repository safety guard (708 failures). No product/test changes: setting TMPDIR/TMP/TEMP to /tmp makes isolated telemetry/process-signal suites pass 6/6. Full suite rerun with this environment; all subsequent gates use it. CEZ_INSTANCE_ID is removed only in test subprocesses because it adds an optional health field.
- Newest release line origin/release/v0.19.x contains the identical vulnerable stat(path)/readFile(path) pair; request its backport.

## Review boundaries
The fix pins pathname replacement to the opened inode. It does not make Git staging atomic with the scan, prevent same-inode writes/growth, or introduce a file-access sandbox. The existing 2 MB metadata threshold and fail-open missing/unreadable-file behavior remain.

- Corrected-temp full `npm test`:15,328 passed,8 skipped,one unrelated Codex SIGTERM classification timing failure. The unchanged Codex suite passes35/35 in isolation. Re-running the complete suite with `--maxWorkers=4` to reduce scheduling pressure; no test assertions, retries, or product code altered for that failure.

- The four-worker rerun also reproduced the unchanged Codex fixture failure and was canceled after that known failure so validation could restart on the corrected fixture. Diagnosis: the fixture recorded SIGTERM before constructing the session; Codex only accepts signals since its own startedAt timestamp. Test setup now records alongside child termination after first output; original outcome/event assertions and all production runner code are unchanged. This is a validation prerequisite, not a second security remediation group.

Final author gate: all five ordered commands pass on the final code/test contents, with `env -u CEZ_INSTANCE_ID TMPDIR=/tmp TMP=/tmp TEMP=/tmp` and600-second bounds. Typecheck pass; npm test15,329pass/8existing skips; Node unit51pass; build/check:pack pass(1,496files,341web assets); package34pass. `git diff --check` and extracted tracker helper `bash -n` pass. No dependency/manifest/env/default changes.

## Independent review and external handoff
Reviewer 6fb71ce0 independently reviewed cbbfb7db with om-auto-review-pr/om-code-review, reproduced original-source 6 fail / 1 pass, restored the exact source, passed 27targeted cases and all five ordered gates (15,329 Vitest / 8 existing skips, 51 Node unit, 34 package), and returned approve with no findings. Source and tests are unchanged since that review. Evidence: https://github.com/open-mercato/cezar/pull/2091#issuecomment-6783539187

Native GitHub approve was attempted and rejected because author/reviewer share the maintenance-bot identity. This is not a native approval. PR remains draft/review/needs-qa for a permitted native reviewer and required QA, as requested; no ready promotion, QA approval, merge or auto-merge. QA instructions: https://github.com/open-mercato/cezar/pull/2091#issuecomment-6783539540

Final automated remediation run is complete. CodeQL24 is handled by a verified draft PR, not resolved on main. Source inventory at final refresh remains 50 Dependabot / 11 CodeQL. Counts:1 handled, 41 existing-PR skips, 19 blocked/deferred. Newest main 9cbdd888 still contains the original defect. Current PR1253 bb98c37c still has vulnerable katex; foreign ownership preserved. Twelve checks on reviewed code head succeeded; no CI waiting or monitoring promise.
