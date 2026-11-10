# Linear suffix normalization

Goal: remediate CodeQL: open-mercato/cezar#8 and CodeQL: open-mercato/cezar#9 without changing normalized values.

Scope: API base URL normalization, attachment filename suffix normalization, related regression tests.
Non-goals: dependencies, workflows, settings, issue creation, alert dismissal, merging or ready promotion.

## Implementation plan

1. Verify latest main and duplicate claims; publish this plan as an early draft.
2. Replace trailing-character regexes with backward scans. Preserve ASCII slash/dot/space rules, truncation order, extension selection and null behavior. Add compatibility and adversarial regression coverage; demonstrate red with original sources and green with fixes.
3. Run configured npm gates in order with bounded timeouts, disclose failures, review diff, check release-line applicability and labels, hand draft to parent for independent review.

## Risks

Shared contract behavior must remain byte-compatible. Attachment stem is already bounded, so its practical exposure is limited; tests must still prove the removed regex is not executed. No configuration changes.

## Progress

PR: #1978

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Claim

- [x] 1.1 Verify alerts and latest main; commit plan and publish draft.

### Phase 2: Fix

- [x] 2.1 Implement linear normalization and prove regression tests red/green. — de09d8a5

### Phase 3: Validate

- [x] 3.1 Run ordered gates and hand off draft for independent review.

## Evidence

- Base: latest origin/main `aad51073`; authenticated API confirms both alerts open, `js/polynomial-redos`, high security severity. Both targeted source files identical to main before edits.
- Scope scan of paginated open PRs before publication and final push found only this PR with the two source markers. No competing claim on this PR; bot assignment returned 403, so the permitted bot exception uses a run-specific claim comment and `in-progress` label, released at handoff.
- Plan-first commit: `16f722fe`.
- Red: `git stash push -- packages/api-client/src/utils/project-scope.ts packages/contract/src/runs.ts`, then `timeout 60 npm test -- packages/api-client/src/utils/normalization-security.test.ts`: 2 failed (each flagged regex executed), 20 passed. Restored with `git stash pop`.
- Green: `timeout 60 npm test -- packages/api-client/src/utils/normalization-security.test.ts packages/api-client/src/utils/project-scope.test.ts packages/cezar/src/workflows/pasted-attachments.test.ts packages/cezar/src/server/health-topic.test.ts`: 117 passed.
- Final ordered gate (inherited `CEZ_*` unset, `TMPDIR=/tmp`): `timeout 300 npm run typecheck` PASS; `timeout 600 npm test` PASS (14234 passed, 8 skipped, 889 files passed/3 skipped); `timeout 300 npm run test:unit` PASS (50); `timeout 300 npm run build` PASS including check:pack; `timeout 300 npm run test:package` PASS (34).
- Initial gate caught test-spy overload typing, corrected before final gate. Initial full suite had one unrelated health-topic assertion failure (14233 passed); isolated rerun and final full suite pass. No failures suppressed.
- `git diff --check` PASS. No separate lint/resolution script configured for these packages; typecheck, build and packaged declaration/CLI checks cover module resolution.
- Backport: both expressions verified on origin/release/v0.18.x; corresponding label applied. No dependencies changed.
- Complexity: scans monotonically decrement an index, then slice once; attachment truncation, ASCII dot/space treatment, trim order, extension selection and null results retained. The bounded attachment stem limits practical exposure; deterministic regex-execution guards avoid timing-flaky assertions.
- Draft remains pending parent-dispatched independent final review and QA. No ready promotion, merge, alert dismissal, settings or workflow changes. Remote CodeQL confirmation is pending; alerts are not claimed closed on main.
