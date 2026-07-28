# Fix queued follow-up provider routing

## Goal

Allow users to append prompt messages to an already-queued run without requiring an unrelated provider to be authorized, while preserving provider authorization gates for live messages and session continuations.

Source doc: `.ai/specs/2026-07-22-provider-authentication.md`

## Scope

- Treat queued prompt stacking as a mutation of an existing task, not as a new provider-starting action.
- Keep the server and cockpit gates aligned: queued messages bypass provider discovery, while running/waiting messages remain gated against the active backend.
- Add regression coverage for the reported Codex-queued/Claude-disconnected scenario at both API and UI boundaries.
- Validate against the queued prompt behavior documented in `.ai/specs/2026-07-21-queued-session-prompt-stacking.md`.

## Non-goals

- Do not change provider discovery, authorization commands, or enablement preferences.
- Do not change runner/model selection for new runs or continuations.
- Do not alter queue scheduling, prompt folding, or live-session delivery semantics.

## Implementation Plan

### Phase 1: Correct queued-message gating

1. Update the message API to skip provider authorization only while the run record is queued, and add a regression test proving prompt stacking does not probe or require provider credentials.
2. Update the task-thread composer to keep queued prompt authoring enabled regardless of provider state, with a regression test matching a Codex-capable host where Claude is disconnected.

### Phase 2: Verify and finalize

1. Run focused server and cockpit tests, then the configured validation commands in order.
2. Run the authoritative PR review/autofix pass, capture verification evidence on the PR, and finalize the PR for review.

## Risks

- The dequeue-to-session-open race can still present a queued record while the manager has moved into its starting state. Allowing that message is intentional: the engine's existing three-rung ladder buffers it so the message is not lost.
- A too-broad bypass could weaken live-session authentication enforcement. Regression tests retain the existing assertion that live messages are blocked when their active provider is unavailable.

## Progress

PR: #712

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Correct queued-message gating

- [x] 1.1 Update the message API to skip provider authorization only while the run record is queued, and add a regression test proving prompt stacking does not probe or require provider credentials. — 6c4b91c0
- [x] 1.2 Update the task-thread composer to keep queued prompt authoring enabled regardless of provider state, with a regression test matching a Codex-capable host where Claude is disconnected. — ce7a5a55

### Phase 2: Verify and finalize

- [x] 2.1 Run focused server and cockpit tests, then the configured validation commands in order. — ce7a5a55
- [x] 2.2 Run the authoritative PR review/autofix pass, capture verification evidence on the PR, and finalize the PR for review. — 5588b878
