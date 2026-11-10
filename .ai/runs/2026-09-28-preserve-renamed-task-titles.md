# Preserve renamed task titles

Goal: prevent stale SSE/reconnect cache data from replacing a successful user rename, while keeping server-authoritative later user renames working across task list, detail, and finder caches.

Scope: `packages/web/src/api/events.ts`, `packages/web/src/api/queries.ts`, `packages/web/src/routes/tasks-overview.tsx`, and focused web tests under `packages/web/src/api/` and `packages/web/src/routes/`.

Non-goals: no server or wire-contract changes, no changes to auto-title generation, no broad cache redesign, and no unrelated UI work.

## Implementation Plan

### Phase 1: Reproduce and protect cache ownership

- [x] 1.1 Add reducer regression tests proving stale auto/undefined title data cannot replace user/marker-owned titles while ordinary fields still merge. — 286a5157
- [x] 1.2 Add query/mutation regression coverage for successful rename write-back and runs-index invalidation. — 286a5157

### Phase 2: Implement and validate

- [x] 2.1 Enforce title-origin precedence in the shared `mergeRun` reducer. — 286a5157
- [x] 2.2 Apply successful rename responses to list/detail/index caches and invalidate authoritative queries in both rename surfaces. — 286a5157
- [x] 2.3 Run focused tests, prove the regression tests fail against the pre-fix code, run the full validation gate, and complete review/QA evidence. — 9e4902c0

Risks: cache keys and list shapes must remain aligned across project-scoped queries; a response write-back must not prevent later authoritative refetches or a newer user rename from winning.

## Progress

PR: #1125 (https://github.com/open-mercato/cezar/pull/1125)

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Reproduce and protect cache ownership

- [x] 1.1 Add reducer regression tests proving stale auto/undefined title data cannot replace user/marker-owned titles while ordinary fields still merge. — 286a5157, 7f589ead
- [x] 1.2 Add query/mutation regression coverage for successful rename write-back and runs-index invalidation. — 286a5157

### Phase 2: Implement and validate

- [x] 2.1 Enforce title-origin precedence in the shared `mergeRun` reducer. — 286a5157, 7f589ead
- [x] 2.2 Apply successful rename responses to list/detail/index caches and invalidate authoritative queries in both rename surfaces. — 286a5157
- [x] 2.3 Run focused tests, prove the regression tests fail against the pre-fix code, run the full validation gate, and complete review/QA evidence. — 9e4902c0
