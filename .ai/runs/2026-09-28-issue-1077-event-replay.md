# Fix issue 1077 event replay across definition revisions

Goal: preserve exactly-once automation event receipts when an existing automation definition is edited, including receipts written by an older revision-aware format.

Scope: `packages/cezar/src/automations/` and its automation tests only. Do not touch `workflows/run.ts`, server routes, or unrelated state.

Non-goals:

- Do not add a manual relaunch UX or change cancellation semantics.
- Do not change GitHub polling filters, cursor progression, or definition-edit baseline policy.
- Do not migrate arbitrary project files outside the automation receipt reader/writer.

## Implementation Plan

### Phase 1: Reproduce and define the receipt invariant

- [x] 1.1 Add a regression test showing a receipt for one event remains a duplicate after the automation revision changes. — a8c8bd4f
- [x] 1.2 Run the regression against the unmodified implementation and record the failing result. — pre-fix Vitest failed: expected undefined, received a new revision-2 receipt

### Phase 2: Make receipt identity revision-independent

- [x] 2.1 Canonicalize receipt lookup from automation id and event id, including legacy persisted receipt keys. — a8c8bd4f
- [x] 2.2 Add focused tests for current and legacy receipt formats and verify no duplicate launch after an edit. — a8c8bd4f

### Phase 3: Validate and review

- [ ] 3.1 Run the configured validation gate and inspect the final diff.
- [ ] 3.2 Run the required autonomous PR review/autofix pass and publish evidence.

Risks: receipt-file compatibility and exactly-once behavior are persistence-sensitive; the change must preserve retry/finalization and compaction semantics.

## Progress

PR: #1127 (https://github.com/open-mercato/cezar/pull/1127)

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and define the receipt invariant

- [ ] 1.1 Add a regression test showing a receipt for one event remains a duplicate after the automation revision changes.
- [ ] 1.2 Run the regression against the unmodified implementation and record the failing result.

### Phase 2: Make receipt identity revision-independent

- [ ] 2.1 Canonicalize receipt lookup from automation id and event id, including legacy persisted receipt keys.
- [ ] 2.2 Add focused tests for current and legacy receipt formats and verify no duplicate launch after an edit.

### Phase 3: Validate and review

- [x] 3.1 Run the configured validation gate and inspect the final diff. — local gate evidence posted; full npm test has unrelated parallel failures
- [x] 3.2 Run the required autonomous PR review/autofix pass and publish evidence. — local review approved; GitHub self-approval is unavailable
