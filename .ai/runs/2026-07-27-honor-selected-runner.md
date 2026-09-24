# Honor selected runners across task starts

## Goal

Ensure every task-start and continuation surface honors the runner shown or explicitly selected for the active project, even when the boot project's default runner differs.

## Scope

- Resolve task-start defaults from the active project's scoped config rather than the boot-bound health payload.
- Preserve explicit/sticky runner selections in New Task, planned starts, GitHub hand-offs, Inbox starts, and bookmarklet starts.
- Keep continuation affinity and explicit continuation overrides intact, and make queued-run runner display use the active project's config.
- Add regression coverage for cross-project default mismatches and every affected start path.

## Non-goals

- No runner protocol, backend implementation, provider-authentication, or workflow step-override changes.
- No changes to the protected boot-project `/api/health` response or bookmarklet URL grammar.
- No migration or rewrite of historical run records.

## Source doc

`.ai/specs/2026-07-20-multi-project-workspace.md`

## Implementation Plan

### Phase 1: Correct runner resolution

1.1 Make shared start-surface engine resolution use the active project's config and preserve explicit runner intent.
1.2 Apply the same scoped-default and explicit-intent rules to New Task, planned starts, and bookmarklet starts.
1.3 Audit continuation and queued-run display paths, correcting any remaining boot-health dependency without changing session-affinity semantics.

### Phase 2: Lock behavior with regressions

2.1 Add pure and component tests for mismatched boot/project defaults across New Task, GitHub, Inbox, plans, bookmarklets, and continuations.
2.2 Run focused cockpit tests and manually verify the effective request/runner behavior for the cross-project scenario.

### Phase 3: Validate and review

3.1 Run the configured validation gate, complete the authoritative PR review/autofix pass, and record verification evidence.

## Risks

- Untouched picks must still follow the active project's configured default; tests distinguish untouched choices from explicit or sticky selections.
- Continuations must keep existing-session affinity unless the user explicitly switches runner or the current provider is unavailable.
- `/api/health` remains boot-project-only by contract, so the fix must move consumers rather than reshape that response.

## Progress

PR: #699

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Correct runner resolution

- [x] 1.1 Make shared start-surface engine resolution use the active project's config and preserve explicit runner intent. — 4182b046
- [x] 1.2 Apply the same scoped-default and explicit-intent rules to New Task, planned starts, and bookmarklet starts. — 4182b046
- [x] 1.3 Audit continuation and queued-run display paths, correcting any remaining boot-health dependency without changing session-affinity semantics. — 4182b046

### Phase 2: Lock behavior with regressions

- [x] 2.1 Add pure and component tests for mismatched boot/project defaults across New Task, GitHub, Inbox, plans, bookmarklets, and continuations. — 4182b046
- [x] 2.2 Run focused cockpit tests and manually verify the effective request/runner behavior for the cross-project scenario. — 4182b046

### Phase 3: Validate and review

- [x] 3.1 Run the configured validation gate, complete the authoritative PR review/autofix pass, and record verification evidence. — 9a0a2d15
