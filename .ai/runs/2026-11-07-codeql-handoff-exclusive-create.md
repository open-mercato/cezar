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

- [x] 2.1 Prove regression and run configured validation gate — 2ed73f60
- [ ] 2.2 Obtain independent review and publish evidence

Regression evidence: before source fix, handoff-seed.test.ts failed 2/4 cases (concurrent journal overwrite and dangling symlink write); after fix both handoff suites pass 19/19.

## Alert disposition
- Handled candidate: CodeQL #23 (handoff seed check/use race); still open on main until merge and rescan.
- Deferred CodeQL: #86, #62, #42, #34, #32, #31, #30, #29, #28, #27, #26, #25, #24, #22. Read current locations; no fix or false-positive dismissal claimed. Keep this PR scoped to one validated defect.
- Dependabot duplicate coverage: 39 identities overlap open PR #1253, independently verified against its head 0dabd517. Main remains vulnerable (DOMPurify 3.4.12; undici 7.30.0/6.29.0; hono 4.12.29). No fix claimed from PR existence.
- Blocked Dependabot #68 @hono/node-server: patched 2.1.3 exceeds current major constraint.
- Blocked #52 zod: exact e2e pin; latest parent upgrade exceeds current constraint.
- Blocked #56 compression: current and latest serve pin vulnerable 1.8.1; parent upgrade cannot remove it. No override introduced.
- Blocked desktop #75/#74/#73 zip: 4 to 9 major upgrade; #41 glib: GTK/Tauri graph compatibility; #72/#71/#70/#69 rustls: compatible patch exists but cargo unavailable in runner.
- No issues, advisory publication, alert dismissals, settings/workflows, automerge labels or merges performed.

## Review workflow blocker
The repository .ai/trackers/github.md lacks get-lock/acquire-lock/release-lock. Installed om-auto-review-pr requires these atomic operations and explicitly forbids fallback on missing operations. Do not update tracker/settings in this task. Read-only independent final review will be requested, but formal review workflow and manual QA remain pending; keep draft and Status in-progress.

## Validation results
Initial ordered gate: typecheck 0; npm test 1 (14326 pass, 6 failures: five disk-quota errors and inherited CEZ_INSTANCE_ID health shape); test:unit 0 (50 pass); build 0 including check:pack; test:package 0 (34 pass).
Corrected environment: unset CEZ_INSTANCE_ID; export TMPDIR to a newly created task-owned directory on the main filesystem (/tmp is quota-limited tmpfs). No product/test changes for these failures. Ran in order:
- timeout 600 npm run typecheck — exit 0.
- timeout 600 npm test — exit 0; 14332 passed, 8 skipped, 895 files passed and 3 skipped.
- timeout 600 npm run test:unit — exit 0; 50 passed.
- timeout 600 npm run build — exit 0, including contract inlining and check:pack.
- timeout 600 npm run test:package — exit 0; 34 passed.
- git diff --check — exit 0.
Targeted command: timeout 120 npm test -- packages/cezar/src/handoff-seed.test.ts packages/cezar/src/handoff.test.ts — 19 passed. Same new suite before source fix: 2 failed, 2 passed. Behavioral tests prove concurrent creation and dangling-symlink target survival, not just source shape.
The health test also failed when rerun alone with inherited CEZ_INSTANCE_ID; passed as part of the clean full suite. Filesystem failures report EDQUOT; rerun on main filesystem passes unchanged source.
No browser QA performed. Formal review workflow cannot run until repository tracker provides required atomic claim operations. Keep draft.

## Independent final review
Task 33005791-175d-46df-ad9a-3ae4f40c1bfd reviewed implementation head 2df303c1: **approve**, no Blocker/Major findings. It independently ran all five configured commands (all exit 0; 14332 full tests, 50 unit, 34 package), plus handoff-seed/handoff/handoff-cli (32/32). Parent independently reran those three files after the report: 32/32. No child source changes or merges. Reviewer confirmed both execute and continuation use this helper, and baseline red log shows the two intended failures.
Minor metadata findings addressed: added bug category and backport release/v0.18.x; parent verified vulnerable seed exists on that release line. No code changed after independent review.
Step 2.2 remains pending only for formal om-auto-review-pr (missing atomic tracker operations) and manual QA; PR remains draft/needs-qa, Status in-progress. Resume: om-auto-continue-pr 1999 after tracker capability blocker is resolved. Current task remediation stops here rather than changing settings or bypassing gates.
