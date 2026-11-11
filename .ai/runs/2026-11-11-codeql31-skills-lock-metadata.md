# Pin skills-update lock metadata to one opened file

Goal: prevent a replaced cache-lock pathname from mixing one file's timestamp with another file's PID/timestamp contents (CodeQL alert 31).

Security-Source: open-mercato/cezar:code-scanning:31
Security-Fingerprint: js/file-system-race:packages/cezar/src/skills-update.ts:readLockMetadata
Source doc: .ai/specs/2026-07-22-automatic-open-mercato-skills-updates.md

## Scope

Change only the internal metadata reader and dedicated tests. Preserve default-on post-listen updates, the six-hour cache, two-minute stale-lock bound, live-PID contention, dead-lock recovery, malformed/read-failure fallback and graceful degradation. No public API, environment, dependency, setting, workflow or persistence-format change.

Non-goals: redesign lock acquisition/release, claim CodeQL 30's stale-lock replacement path fixed, prevent same-inode mutation or parent-directory attacks, update dependencies already covered by PR1253, merge or dismiss alerts. Highest-risk uncovered Rust dependency groups need parent-major/toolchain validation and remain deferred; one isolated CodeQL group is selected.

The initial scan verified all61 identities:43 covered by existing PRs,18 uncovered. The operator then requested autonomous continuation. This run uses the locally installed pipeline's verbatim atomic operations per-run, preserving repository settings/descriptor bytes. Claim identity:1285b950-d49e-4084-b715-6b8f44cc9f7b. Existing claims and PRs were rechecked; no overlapping CodeQL31 remediation found. At most two subtasks have already been used; the existing final reviewer must be resumed for the implementation review rather than creating a third.

## Implementation plan

### Phase 1: Descriptor-bound metadata

1.1 Add deterministic filesystem regressions, implement open/fstat/read/finally-close, and prove the security regression fails against the original source.

### Phase 2: Verification and handoff

2.1 Run existing service/coordinator/server integration coverage and all configured validation commands in order, record exact commands/results and backport decision.

2.2 Obtain an independent implementation review through om-auto-review-pr, publish evidence/labels, and finalize the same draft PR after verification.

## Risks

The old metadata path is load-bearing for stale-lock recovery and bounded contention. Descriptor cleanup must cover success, malformed contents and I/O errors. This fix does not make stale-lock removal or release atomic against competing pathname replacements; CodeQL30 is explicitly outside the completion claim. Source alerts stay open on main until merge/rescan. Native GitHub self-approval can be refused; record the independent code verdict separately and retain QA/native merge gates.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Descriptor-bound metadata

- [ ] 1.1 Add deterministic filesystem regressions and bind metadata to one descriptor

### Phase 2: Verification and handoff

- [ ] 2.1 Complete targeted integration and ordered validation gate
- [ ] 2.2 Obtain independent implementation review and finalize PR evidence
