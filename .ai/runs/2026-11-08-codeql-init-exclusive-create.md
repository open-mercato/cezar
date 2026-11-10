# Protect init example creation

Goal: Fix CodeQL alert 25 without overwriting existing init examples.

Scope: Extract the init command for direct tests; use exclusive creation and preserve existing-file messages. The temporary tracker-descriptor upgrade was removed following independent review of authorization; the final diff leaves all settings/workflows unchanged. The already acquired PR claim is retained only through review and ownership-aware cleanup.

Non-goals: Other alert sources, issues, dependency upgrades, merges, releases, settings and CI workflows.

Source identity: github-code-scanning:open-mercato/cezar:25
Source fingerprint: js/file-system-race:packages/cezar/src/index.ts:initCommand:example-create
Source doc: AGENTS.md (CLI init never overwrites); BACKWARD_COMPATIBILITY.md

## Implementation Plan

### Phase 1: Ownership and regression
1.1 Install missing atomic tracker operations and publish plan draft.
1.2 Extract init and prove concurrent-file and symlink regressions fail before the fix.

### Phase 2: Fix and verification
2.1 Exclusively create examples, skip EEXIST, propagate other errors.
2.2 Run targeted tests and ordered full validation; independently review before readiness.

## Risks

Validation evidence: .ai/runs/2026-11-08-codeql-init-exclusive-create-verification.md. The initial inherited-environment failures are retained in evidence. The clean-environment full gate now passes, and the independent reviewer approves final head6e156726. Native GitHub self-approval is rejected; eligible formal approval, QA and remote checks still gate merge.

65 open alerts were authenticated and paginated: 44 covered by existing PRs, 21 residual. Select only unclaimed high alert 25. Other candidates remain deferred or toolchain/compatibility blocked. Recheck before publication. Two child tasks total were used; the existing independent reviewer was continued for implementation review and final approval without creating a third task. Latest release/v0.18.x has the vulnerable loop, requiring its backport label.

## Progress

PR: #2009

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Ownership and regression

- [x] 1.1 Install missing atomic tracker operations and publish plan draft. — 92cc482f
- [x] 1.2 Extract init and prove concurrent-file and symlink regressions fail before the fix. — ad149518

### Phase 2: Fix and verification

- [x] 2.1 Exclusively create examples, skip EEXIST, propagate other errors. — ad149518
- [x] 2.2 Run targeted tests and ordered full validation; independently review before readiness. — 6e156726

Post-review scope correction: tracker-descriptor addition removed completely in4e24b1a7; final settings/workflow diff is empty.
