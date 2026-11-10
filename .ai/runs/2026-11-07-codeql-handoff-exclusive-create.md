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
- [x] 2.2 Obtain independent review and publish evidence — reviewed 0da280d2; final independent approve after container gate

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

## Prior review blocker (resolved by container validation)
The primary checkout tracker descriptor now provides get-lock/acquire-lock/release-lock. Final independent task 32e7a371 used that descriptor directly, acquired create-only refs/om-locks/pr-1999 (metadata SHA fe638a24307ac96f575b7135e5c3127676dbb9b1; claim comment 6702743796), and did not change configuration.

Formal review: https://github.com/open-mercato/cezar/pull/1999#pullrequestreview-5810314676
Verdict: **request changes — infrastructure/validation blockers**, reviewed exact head bfc5fd74830ac2d1af331066cf4a3a3adfe4c0ac. No code-level Blocker/Major findings; no source or test edits. GitHub COMMENT is required because this reviewer shares the PR author's bot identity; it does not satisfy required independent GitHub approval.

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

## 2026-11-07 final review evidence and handoff
Independent ordered gate after npm ci, CEZ_INSTANCE_ID unset, task-owned main-filesystem TMPDIR:
- timeout 600 npm run typecheck: 0.
- timeout 600 npm test: 1; 12 failed, 14320 passed, 8 skipped; 5 failed files, 890 passed, 3 skipped.
- timeout 600 npm run test:unit: 0; 50 passed.
- timeout 600 npm run build: 0; check:pack passed.
- timeout 600 npm run test:package: 0; 34 passed.
- timeout 120 npm test -- packages/cezar/src/handoff-seed.test.ts packages/cezar/src/handoff.test.ts packages/cezar/src/handoff-cli.test.ts: 0; 32 passed.
- git diff --check: 0.
Regression independently reproduced in an isolated archive: reverting only handoff.ts to main gives 2 failed/2 passed (concurrent overwrite and dangling symlink); reviewed source passes. The five environmental failing files also reproduce in that archive with original handoff source: 12 failed/96 passed.
An owned platform /tmp write probe returns errno 122 (Disk quota exceeded). Agent fallback deliberately clears TMPDIR/TEMP/TMP (agent-tmpdir.ts:76–104), so the task-owned main-filesystem override cannot avoid this quota for those paths. No foreign temporary files removed and no test/product workaround added.
CI run 42313278920 failed-job rerun completed FAILURE; maintainer must resolve the failing CI evidence as well as restore runner scratch capacity. Branch protection read is 403; all reported checks conservatively remain gates. Current check results: see PR checks and formal review. Keep draft, Status in-progress, changes-requested and needs-qa; no manual QA signoff invented. Resume om-auto-continue-pr 1999 after infrastructure/CI recovery. Step 2.2 remains unchecked because the mandatory validation/review gate cannot approve.
Historical missing-descriptor statements above describe prior runs only; atomic ownership is now available. Prior passing tests are attributed evidence, not this final task's green gate. Claim cleanup is reported on the original claim comment and in the task report, using expected-SHA lease release.

## Final resumed independent review — complete
Task 32e7a371 resumed without new dispatch. Independently inspected the parent's container script, all five logs and exit results, then independently executed ALL FIVE ordered commands again at exact source/head 0da280d2b2a1895ad6874fc0c1d5a77c84645614 in cached mcr.microsoft.com/playwright:v1.62.1-noble (image sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e), user 1001:1001, --rm --pull never. Linked PR worktree writable, common Git directory read-only, own healthy /tmp, CEZ_INSTANCE_ID unset; no source/configuration/workflow changes.
- timeout 600 npm run typecheck: PASS, 0.
- timeout 600 npm test: PASS, 0; 14332 passed, 8 skipped, 895 files passed and 3 skipped.
- timeout 600 npm run test:unit: PASS, 0; 50 passed.
- timeout 600 npm run build: PASS, 0; check:pack passed (1286 files).
- timeout 600 npm run test:package: PASS, 0; 34 passed.
- git diff --check: PASS. Prior independently executed 32 handoff/CLI tests and deterministic regression proof remain valid; no source/test changes since.
Reviewer's raw logs: /home/maintenance/cez-review-1999/container-{typecheck,test,test:unit,build,test:package}.log and container-results.txt. Parent independently passed the same complete gate; its separate logs live in the dispatch tree. Host /tmp EDQUOT is environmental and is resolved for validation by the container; no product workaround or assertion weakening.
GitHub CI run 42342714986 and CodeQL 42342715060 completed successfully at 0da280d2, including previously failing shard 2/3; all 14 reported checks pass or skip, and all four observed workflow runs at that head are completed. Branch-protection read remains 403, so all checks are conservatively treated as gates. A tracking-only completion commit can start new CI; current-head checks remain the merge authority.
Final verdict: **approve**, no remaining Blocker/Major findings. Formal re-review is published on PR #1999 (COMMENT due to shared author-bot identity); this is independent task approval, not a GitHub binding self-approval. Step 2.2 is complete. Status complete and ready-for-review are appropriate under om-auto-continue-pr / om-auto-review-pr; manual QA and required independent GitHub approving review still block merge. Preserve needs-qa; never qa-approved or qa-self-verified from this code review. No merge/automerge, alert dismissal, new issue/PR, settings or workflow changes.
Resumed atomic ownership: Claim-Run 32e7a371-final-resume-20261107, ref refs/om-locks/pr-1999, metadata SHA 61a36338c80e51d30687bb9923906f9919c6ec27, claim comment 6702904921. Release is via expected-SHA lease, with original claim terminal state and label cleanup recorded on GitHub and in the task report.
