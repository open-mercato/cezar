# CodeQL22: protect data gitignore maintenance

Goal: prevent .ai/cezar/.gitignore maintenance from following replacement links or overwriting a concurrent file while preserving zero-config additive ignore entries.

Source doc: AGENTS.md; BACKWARD_COMPATIBILITY.md §3; CodeQL open-mercato/cezar:code-scanning:22.
Security-Source: open-mercato/cezar:code-scanning:22
Security-Fingerprint: js/file-system-race:packages/cezar/src/data-gitignore.ts:ensureDataGitignore
Status: complete
Claim-Run: db8187b4-154c-4c81-99e1-848a94cb7893

## Scope and non-goals
Only the data-gitignore helper, dedicated security tests and run evidence. Retain entries, user additions, repeat-call idempotence and nonthrowing startup. No API/persisted shape/env changes; no dependencies, settings/workflow changes, issue creation or merge. Parent-directory attacks, hard links and concurrent writes to an already-open inode are outside this leaf-identity fix.

## Implementation plan
Phase 1: write deterministic regressions against actual temporary files; demonstrate original-source failure, then use exclusive creation and a validated regular-file descriptor for read/append, closing on every exit.
Phase 2: run focused integration/unit coverage and the five configured validation commands in order; distinguish baseline/environment failures.
Phase 3: reuse the final independent reviewer task for the implementation, publish review/QA evidence and release the exact atomic claim. Keep draft if verification incomplete.

## Risks and decisions
Initial scan:50 Dependabot+11 CodeQL;42 identities duplicate-covered by existing PRs. This is one uncovered high CodeQL group; no competing source claim/PR found on refreshed main9cbdd888. Original helper existence-checks then path-reads/path-writes, permitting target replacement and concurrent creation truncation.
After repeated explicit operator continuation, use the exact installed skill template's atomic GitHub operations as a per-run compatibility source; repository tracker/settings/workflows stay byte-identical to main. This supersedes the earlier missing-operation stop for this run, never atomic ownership or other guardrails. Helper source: installed om-setup-agent-pipeline/references/trackers/github.md; label guards remain repository-authoritative. Atomic claim: refs/om-locks/pr-2093 at ad75021fd4d56919593bc778c5e70d7ebccec347; comment6788108736. Assignment POST returned403; assignability GET for this bot returned404, confirming unassignable. Verified in-progress and exact ownership. Persist PR lock SHA/comment IDs in evidence. No comment-election fallback.
Independent reviewer9eac6c64 will be resumed for the same task (two subtasks total already used); no third task will be created. Native GitHub self-approval may be rejected; report separately from independent task verdict.

## Progress

PR: #2093

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Regression and fix

- [x] 1.1 Prove file-target replacement defects and fix descriptor-based maintenance — 649d69885cdf070eee6c21cda7abf8ffe75fe8f6

### Phase 2: Validation

- [x] 2.1 Pass focused coverage and the ordered full validation gate — ec40a532bd80c297604fece07faa644813c71297

### Phase 3: Independent review and handoff

- [x] 3.1 Obtain independent review and finalize the remediation PR — be53aa4798ee0d61453e03d6324135fd9b83b92b

Implementation independently approved by task9eac6c64 (review5854506094); full gates independently pass. Native GitHub approval was rejected as author self-review and is not claimed. QA instructions6788376946 posted; needs-qa remains. PR is handed to permitted native review and QA, with no merge/auto-merge. Final source is unchanged from independently reviewed edb5a41f; subsequent commits only record run evidence/Progress.
