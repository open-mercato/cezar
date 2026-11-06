# Preserve handoff journals during initialization

Goal: prevent handoff seeding from overwriting a journal created concurrently.
Source doc: .ai/specs/007-handoff-file-todos.md (per-task journal contract).
CodeQL: open-mercato/cezar#23
Fingerprint: packages/cezar/src/handoff.ts:seedHandoffFile:existsSync/writeFileSync

## Scope
Only handoff seeding and regression tests. Preserve existing journal contents, return path, skeleton format and best-effort failure behavior. Non-goals: heartbeat/resume writes, API changes, dependencies, settings, workflows and startup behavior.

## Implementation Plan
### Phase 1: Atomic initialization
1.1 Replace check-then-write with exclusive file creation; test creation, existing journal and deterministic concurrent creation.
### Phase 2: Verification and review
2.1 Prove regression red/green and run ordered configured validation gate.
2.2 Obtain independent review and publish evidence; retain draft if validation incomplete.

## Risks
A missing/read-only data directory must remain non-fatal. Existing symlinks must not be followed for writing. Scope is local defense in depth, not a remote exploit claim.

## Selection evidence
Authenticated paginated APIs returned 50 Dependabot and 15 CodeQL alerts; main bde4e54a. All-state PR scan (1315 records) found no remediation for #23. Dependency triage found 39 alert overlaps with PR #1253 and 11 residual compatibility/toolchain blockers; no duplicate dependency PR created. Active issue/advisory automation claims inspected; no handoff claim found. Installed skill engine uses 3 Steps (threshold 20).

## Progress
PR: #1999

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Atomic initialization

- [x] 1.1 Replace check-then-write with exclusive file creation — 2ed73f60

### Phase 2: Verification and review

- [ ] 2.1 Prove regression and run configured validation gate
- [ ] 2.2 Obtain independent review and publish evidence

Regression evidence: before source fix, handoff-seed.test.ts failed 2/4 cases (concurrent journal overwrite and dangling symlink write); after fix both handoff suites pass 19/19.
