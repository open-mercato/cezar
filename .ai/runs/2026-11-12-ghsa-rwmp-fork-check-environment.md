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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Environment and shell boundary

- [ ] 1.1 Add credential and shell-startup regression coverage
- [ ] 1.2 Curate untrusted environments and skip shell profiles

### Phase 2: Verification and publication

- [ ] 2.1 Prove targeted removal and pass ordered validation
- [ ] 2.2 Complete PR review and publication evidence
