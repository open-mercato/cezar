# Verify queued screenshot delivery at the HTTP boundary (#926)

## Goal

Keep issue #926 covered at the actual `POST /runs/:id/messages` boundary so a screenshot added to a queued task is retained as attachment content and reaches the queued manager as an image block.

## Scope

- Add focused server-route regression coverage for queued attachment delivery.
- Preserve the already-shipped workflow/dequeue behavior; the original filename is attachment-library metadata, while the queued manager receives the vendor image block without a filename field.

## Non-goals

- Reopen or duplicate the production fix already merged in PR #1246.
- Changes to run headers, workflow execution, run storage, or unrelated composer surfaces.

## Implementation Plan

### Phase 1: Confirm and cover

- [x] 1.1 Verify issue #926 and existing claims/PRs; document that production behavior is already fixed. — 5630521f
- [x] 1.2 Add an HTTP regression test proving a queued screenshot is passed through as the exact image block expected by the queued manager. — 8fe10ce0

### Phase 2: Validate and review

- [x] 2.1 Prove the new assertion detects a route regression, run focused tests, and inspect scope. — red 1 failed with route mapping removed; green 26 passed after restoration — 8fe10ce0
- [ ] 2.2 Run the configured full validation gate and authoritative PR review. — CI gate passed; independent review remains pending

## Risks

This is intentionally test-only because the queued attachment persistence/dequeue fix is already on `main`; changing production code would duplicate PR #1246 and risk scope expansion.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Confirm and cover

- [x] 1.1 Verify issue #926 and existing claims/PRs; document that production behavior is already fixed.
- [x] 1.2 Add an HTTP regression test proving a queued screenshot is passed through as the exact image block expected by the queued manager. — 8fe10ce0

### Phase 2: Validate and review

- [x] 2.1 Prove the new assertion detects a route regression, run focused tests, and inspect scope. — 8fe10ce0
- [ ] 2.2 Run the configured full validation gate and authoritative PR review. — CI passed; independent approval unavailable to PR author
