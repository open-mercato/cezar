# Execution plan — accessible transcript copy (#1194)

This is the issue-specific execution record for PR #1372. The plan was added during
follow-up after implementation had already started; the original plan-first requirement
was missed, and this late addition records that deviation rather than rewriting history.

## Progress

- [x] Read the shared-session renderer architecture and inspect the existing transcript renderers.
- [x] Confirm the root cause: transcript text had no accessible copy action, while rendered Markdown is not the source payload.
- [x] Add guarded copy controls for textual user and assistant messages, preserving edit/remove and streaming behavior.
- [x] Add component coverage for exact user/assistant source payloads, success, rejection, unavailable Clipboard API, attachments, and shared renderers.
- [x] Add browser coverage for keyboard Enter, mobile touch, exact user and assistant payloads, and success feedback.
- [x] Run the configured gate with isolated temporary directories and sanitized test-only environment.
- [x] Capture and inspect desktop/mobile browser evidence; upload both screenshots to the dedicated QA evidence branch.
- [x] Complete the PR review paperwork and leave the PR ready for the parent task's independent final review.

## PR

- Pull request: https://github.com/open-mercato/cezar/pull/1372
- Issue: https://github.com/open-mercato/cezar/issues/1194
