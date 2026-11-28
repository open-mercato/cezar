# Send later for replies in existing tasks

**Status** — Proposed for review. [Issue #2545](https://github.com/open-mercato/cezar/issues/2545)

Allow users to schedule a text reply from the task composer. When due, the reply goes to the same task and conversation using its existing worktree and ordinary delivery rules. This extends [deferred task start](2026-10-07-deferred-task-start.md) with an action targeting an existing run.

## Composer and scope

- **Send later** accepts a future date and time in the server's time zone, which is shown alongside the picker and pending reply. Scheduling makes no model call.
- Allow one outstanding reply per task, including held, missed and failed replies. Show its text, time and status in the task with **Edit**, **Reschedule**, **Send now** and **Cancel** while delivery is still pending. Show the reason and a **Retry** action for recoverable failures.
- Start with one-time, text-only scheduling in the cockpit. Disable scheduling with an explanation while attachments are present or when `CEZ_AUTOMATIONS=0`. Immediate replies still work. CLI, phone relay, managers and recurring replies are outside this proposal.

## Delivery and conversation changes

Choose the delivery path when the reply is due. Use the existing message path for live, parked and queued runs. If an agent turn is in progress, use the existing queue so the reply runs after that turn. For a closed resumable session, including a task in review, use Continue. Resolve the runner, model, account and effort through the ordinary Continue defaults at delivery time. Honour the task's current permissions, review gates, capacity and account holds. If the configured execution settings cannot be resolved, surface the reason and retain the reply for retry.

Record a durable marker for the latest accepted human input when scheduling. A newer human-authored reply, manual Continue or answered question card moves the pending reply to a persisted **Needs confirmation** state. Assistant output and manager or dispatch messages do not move the marker. Check again when handing off for delivery so concurrent human input cannot silently bypass the hold. **Send now** explicitly confirms the newer context. **Reschedule** acknowledges the current conversation and records a new marker.

A scheduled reply never carries an `askRequestId`. If a question card is pending when delivery is attempted, hold the reply and direct the user to answer the card separately. After answering, the user can send or reschedule the held reply. An interrupted attempt with an unknown outcome must be reconciled before allowing edits or resubmission.

## Scheduler, persistence and retention

Add a distinct scheduled reply action targeting a project and run ID. Reuse the one-time automation scheduler, time-zone handling, cross-process lease and occurrence receipts. After downtime, attempt an overdue reply within the existing 24-hour catch-up window. Older replies are marked **Missed** and require an explicit action. The browser may be closed while scheduling or delivery is pending.

Persist the action and its revision in the project's automation state. Expose task-scoped management through typed contract schemas. Use revision checks on user actions and one stable occurrence idempotency key across retries. Route selection and delivery must account for both message and Continue receipts. Once either path has accepted the reply, record it as accepted, including when it is waiting in the ordinary message queue. If an attempt was interrupted, check its receipt before switching paths or retrying. Recheck target eligibility and the human-input marker at acceptance, including queued delivery. If a queued reply becomes stale before the next turn consumes it, hold it in the task rather than sending it to the model.

Count pending replies, including held, failed and missed ones, as activity for automatic worktree reclaim and task retention. Release this protection at delivery or cancellation, with accepted queued messages following ordinary queue retention. An explicit archive, deletion or recorded merge cancels the reply and releases protection. Record the cancellation reason in delivery history even if the task is gone. A missing or ineligible target cannot be reopened by the scheduler.

## Verification for implementation

- No model turn before the due time and no duplicate acceptance after a restart, retry or concurrent Send now.
- Delivery to parked, busy, queued and closed resumable tasks. Review uses the ordinary Continue binding.
- Newer human input holds the reply across restarts. Internal messages leave it scheduled. A pending question card is never answered by scheduled text.
- Pending replies survive cleanup. Archive, delete and merge cancel visibly. Catch-up and missed delivery follow the configured behavior above.
- Edit, reschedule, cancel and retry respect the stored revision. Attachment and automation-disabled states explain why scheduling is unavailable.
