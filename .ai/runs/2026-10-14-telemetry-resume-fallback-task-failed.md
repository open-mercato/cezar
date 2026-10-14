# Execution plan: telemetry for session-resume fallbacks and task failures

Source doc: .ai/specs/2026-10-14-telemetry-resume-fallback-task-failed.md (spec PR #1439)

## Goal
Send two consent-gated telemetry events: `session_resume_fallback` (`recovered`/`fresh_failed`/`cancelled`) and `task_failed` (`<backend>:<kind>`). Closes #1438.

## Scope
- `packages/cezar/src/runs/failure-kind.ts` (new), `runs/store.ts`, `workflows/run.ts`, `telemetry.ts`, `docs/telemetry.md`, tests.

Non-goals: missing-session detection for non-Claude backends (#1193); any schema/API change.

## Risks
Store gains a telemetry import; `track` is fire-and-forget and consent-gated.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: task_failed

- [ ] 1.1 Failure-kind classifier with unit tests
- [ ] 1.2 Fire task_failed from RunStore.updateRun on the transition into failed

### Phase 2: session_resume_fallback

- [ ] 2.1 Track the fallback outcome at both takeFallback sites

### Phase 3: Registry and docs

- [ ] 3.1 TELEMETRY_EVENTS, docs/telemetry.md, add_event registration
