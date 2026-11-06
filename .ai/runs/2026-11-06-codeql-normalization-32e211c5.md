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

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Claim

- [x] 1.1 Verify alerts and latest main; commit plan and publish draft.

### Phase 2: Fix

- [ ] 2.1 Implement linear normalization and prove regression tests red/green.

### Phase 3: Validate

- [ ] 3.1 Run ordered gates and hand off draft for independent review.
