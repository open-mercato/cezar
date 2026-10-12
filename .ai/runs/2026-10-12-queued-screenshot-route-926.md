# Verify queued screenshot delivery at the HTTP boundary (#926)

## Goal

Keep issue #926 covered at the actual `POST /runs/:id/messages` boundary so a screenshot added to a queued task is retained as an attachment and reaches the queued-message response.

## Scope

- Add focused server-route regression coverage for queued attachment delivery.
- Preserve the already-shipped workflow/dequeue behavior and original attachment metadata.

## Non-goals

- Reopen or duplicate the production fix already merged in PR #1246.
- Changes to run headers, workflow execution, run storage, or unrelated composer surfaces.

## Implementation Plan

### Phase 1: Confirm and cover

- [ ] 1.1 Verify issue #926 and existing claims/PRs; document that production behavior is already fixed.
- [ ] 1.2 Add an HTTP regression test proving a queued screenshot is passed through and returned with its original filename.

### Phase 2: Validate and review

- [ ] 2.1 Prove the new assertion detects a route regression, run focused tests, and inspect scope.
- [ ] 2.2 Run the configured full validation gate and authoritative PR review.

## Risks

This is intentionally test-only because the queued attachment persistence/dequeue fix is already on `main`; changing production code would duplicate PR #1246 and risk scope expansion.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Confirm and cover

- [x] 1.1 Verify issue #926 and existing claims/PRs; document that production behavior is already fixed.
- [ ] 1.2 Add an HTTP regression test proving a queued screenshot is passed through and returned with its original filename.

### Phase 2: Validate and review

- [ ] 2.1 Prove the new assertion detects a route regression, run focused tests, and inspect scope.
- [ ] 2.2 Run the configured full validation gate and authoritative PR review.
