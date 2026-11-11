# CodeQL22: protect data gitignore maintenance

Goal: prevent .ai/cezar/.gitignore maintenance from following replacement links or overwriting a concurrent file while preserving zero-config additive ignore entries.

Source doc: AGENTS.md; BACKWARD_COMPATIBILITY.md §3; CodeQL open-mercato/cezar:code-scanning:22.
Security-Source: open-mercato/cezar:code-scanning:22
Security-Fingerprint: js/file-system-race:packages/cezar/src/data-gitignore.ts:ensureDataGitignore
Status: in-progress
Claim-Run: db8187b4-154c-4c81-99e1-848a94cb7893

## Scope and non-goals
Only the data-gitignore helper, dedicated security tests and run evidence. Retain entries, user additions, repeat-call idempotence and nonthrowing startup. No API/persisted shape/env changes; no dependencies, settings/workflow changes, issue creation or merge. Parent-directory attacks, hard links and concurrent writes to an already-open inode are outside this leaf-identity fix.

## Implementation plan
Phase 1: write deterministic regressions against actual temporary files; demonstrate original-source failure, then use exclusive creation and a validated regular-file descriptor for read/append, closing on every exit.
Phase 2: run focused integration/unit coverage and the five configured validation commands in order; distinguish baseline/environment failures.
Phase 3: reuse the final independent reviewer task for the implementation, publish review/QA evidence and release the exact atomic claim. Keep draft if verification incomplete.

## Risks and decisions
Initial scan:50 Dependabot+11 CodeQL;42 identities duplicate-covered by existing PRs. This is one uncovered high CodeQL group; no competing source claim/PR found on refreshed main9cbdd888. Original helper existence-checks then path-reads/path-writes, permitting target replacement and concurrent creation truncation.
After repeated explicit operator continuation, use the exact installed skill template's atomic GitHub operations as a per-run compatibility source; repository tracker/settings/workflows stay byte-identical to main. This supersedes the earlier missing-operation stop for this run, never atomic ownership or other guardrails. Helper source: installed om-setup-agent-pipeline/references/trackers/github.md; label guards remain repository-authoritative. Persist PR lock SHA/comment IDs in evidence. No comment-election fallback.
Independent reviewer9eac6c64 will be resumed for the same task (two subtasks total already used); no third task will be created. Native GitHub self-approval may be rejected; report separately from independent task verdict.

## Progress

> Convention: '- [ ]' pending, '- [x]' done. Append ' — <commit sha>' when a step lands. Do not rename step titles.

### Phase 1: Regression and fix
- [ ] 1.1 Prove file-target replacement defects and fix descriptor-based maintenance

### Phase 2: Validation
- [ ] 2.1 Pass focused coverage and the ordered full validation gate

### Phase 3: Independent review and handoff
- [ ] 3.1 Obtain independent review and finalize the remediation PR
