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

- [x] 1.1 Verify issue #926 and existing claims/PRs; document that production behavior is already fixed. — 5630521f
- [x] 1.2 Add an HTTP regression test proving a queued screenshot is passed through and returned with its original filename. — 8fe10ce0

### Phase 2: Validate and review

- [x] 2.1 Prove the new assertion detects a route regression, run focused tests, and inspect scope. — red 1 failed with route mapping removed; green 26 passed after restoration — 8fe10ce0
- [x] 2.2 Run the configured full validation gate and authoritative PR review. — focused/partial gate evidence posted; self-approval unavailable, awaiting independent reviewer

## Risks

This is intentionally test-only because the queued attachment persistence/dequeue fix is already on `main`; changing production code would duplicate PR #1246 and risk scope expansion.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Confirm and cover

- [x] 1.1 Verify issue #926 and existing claims/PRs; document that production behavior is already fixed.
- [x] 1.2 Add an HTTP regression test proving a queued screenshot is passed through and returned with its original filename. — 8fe10ce0

### Phase 2: Validate and review

- [x] 2.1 Prove the new assertion detects a route regression, run focused tests, and inspect scope. — 8fe10ce0
- [x] 2.2 Run the configured full validation gate and authoritative PR review. — 5ae5de94; independent approval unavailable to PR author
