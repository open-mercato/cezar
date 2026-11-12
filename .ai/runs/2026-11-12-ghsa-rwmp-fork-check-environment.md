# Remove host credentials from untrusted fork check environments

Source doc: `.ai/specs/2026-10-06-agentic-e2e-checks.md` Phase 3.
Source identity: GHSA-rwmp-5wfq-rhxw
Fingerprint: packages/cezar/src/workflows/run.ts:checkStepEnv:process.env+runCheckStep:bash-login
Status: in-progress
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Goal and scope

Untrusted fork check steps receive essential toolchain environment and run context, with no inherited host credentials or shell-startup hooks. Preserve trusted checks, vault bindings, default fork skipping and existing context semantics. No dependency, API, CEZ_* input, setting or workflow changes. No issues, advisory-state changes, releases or merges.

## Implementation plan

### Phase 1: Environment and shell boundary

1.1 Add regression coverage proving inherited arbitrary/provider/GitHub credentials, passthrough toggles and shell hooks cannot reach untrusted checks; exercise real Bash and preserve trusted behavior.
1.2 Implement a small explicit essential-variable allowlist for untrusted checks and a non-login, non-interactive Bash launch. Preserve trusted full environment and login shell.

### Phase 2: Verification and publication

2.1 Run focused regressions with before/after proof, then all five ordered npm validation commands and applicable resolution checks. Document any baseline/environment failures.
2.2 Complete the mandatory PR review with independent final review, normalize labels and publish evidence; keep QA gates intact and draft if incomplete.

## Risks and decisions

- Environment curation does not sandbox fork code or make filesystem-resident credentials inaccessible. Fork heads remain opt-in; document this limitation.
- Avoid buildChildEnv: it intentionally forwards backend/GitHub auth, CEZ_* and passthrough switches. Untrusted checks need a smaller immutable allowlist.
- Preserve original variable spelling for Windows and locale families for existing toolchains. Do not pass NODE_OPTIONS, BASH_ENV, ENV, SSH_AUTH_SOCK or arbitrary prefix families.
- Previous scan stopped at the missing atomic-lock operations in the configured GitHub descriptor. The operator explicitly instructed autonomous continuation. Use the exact locally installed om-setup-agent-pipeline/reference GitHub get-lock/acquire-lock/release-lock protocol as the session execution supplement, with unchanged repository configuration. No comment-mode fallback or invented lock semantics. This supersedes the earlier tooling-blocked report only for this run.
- The task limit remains two subtasks. Reuse the existing final-review task for implementation review through its Continue endpoint; do not dispatch a third task.
- GHSA-7359-xf8g-8826 is already fixed on main; GHSA-9p6p-x956-g9hf remains blocked by explicit prohibition on workflow/settings changes. Prior scan evidence stays in the root task artifacts.
- Backport decision: inspect newest release line before final publication; request backport when the vulnerable code exists there.

## Progress

PR: #2109

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Environment and shell boundary

- [x] 1.1 Add credential and shell-startup regression coverage — 6ec4d643929b828efb26e696c48ebf21503123a9
- [x] 1.2 Curate untrusted environments and skip shell profiles — 6ec4d643929b828efb26e696c48ebf21503123a9

### Phase 2: Verification and publication

- [x] 2.1 Prove targeted removal and pass ordered validation — a4bf099f56054047b7ed22392d8d3d32b5d90e6f
- [ ] 2.2 Complete PR review and publication evidence

Phase 1 evidence: original source fails 3 new security assertions (17 pass); fixed focused suites pass 43/43. Separate actual-module synthetic probe confirms credential removal despite agent passthrough toggles. Trusted checks and default fork skipping remain covered. No source/dependency/settings/workflow changes outside stated scope.

Claim-Run: 622f8d2b-fd98-4e0e-a0e5-3f3a6a332c4f
Claim-Comment: 6815761764
Claim-Lock: refs/om-locks/pr-2109
Claim-Lock-SHA: 2cfb7cdc7d4728761cb775eff46eddcd2e108db5

Phase 2 validation: Node 24.22.2 container, uid/gid 1001 with valid passwd entry, isolated HOME/tmp. Ordered typecheck PASS; npm test PASS (15,328 passed / 8 skipped); test:unit PASS (51); build/check:pack PASS; test:package PASS (34). Git diff --check PASS. First full test attempt had six container userInfo ENOENT failures and one transient unchanged store-concurrency partial-JSON read; all 86 tests in those suites passed focused, then the complete rerun passed. No product workaround or assertion weakening. Logs and actual-module removal probe: root task Assets implementation-evidence.md and gate-*.log. Backport needed: vulnerable code verified on release/v0.19.x. Final independent implementation review/QA signoff remain.
