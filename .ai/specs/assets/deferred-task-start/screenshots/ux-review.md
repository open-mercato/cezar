# Graphical mockups for issue #1340 — UX review

## Verdict: keep

Keep the start selector in the task composer. It lets a user retain the current allowance for interactive work and schedule a task without learning the Automations editor. Scheduling itself needs deterministic rules and provider metadata, not another model call.

Contract: no `.uxproof` design contract was available. This review checks the agreed issue behavior and prototype; it does not certify design-system parity or establish user demand.

## Changes applied

- [HEURISTIC — visibility of system status] Replace the icon-only submit button with its actual action: Start task, Schedule task, or Plan task.
- [HEURISTIC — accurate expectations] Scheduled details explicitly say the server must remain running; closing the tab is safe.
- [ASSUMPTION — reviewer judgment] Keep account, reset time, data freshness and earliest start together. The user can distinguish a reset from a reservation of allowance.
- Align the account-removed message with the agreed cancellation/replacement path. Label all captures Proposed UI.

## Evidence and limits

Rendered and visually inspected three desktop captures plus light-theme and 390px mobile captures in Chromium. Checked Escape dismissal/focus restoration, no horizontal mobile overflow, and no JavaScript errors. Screenshot capture hides demonstration controls, retaining the prototype's product controls and illustrative-data notice.

No implementation, backend scheduling, screen-reader audit or user testing was performed. These are illustrations of the issue, not pixel-exact production screens.

Next useful test: ask an unfamiliar user to schedule after reset, explain when work can start, and cancel the pending task without visiting Automations. If they mistake the time for reserved capacity or cannot locate cancellation, revise the copy or action placement before implementation.
