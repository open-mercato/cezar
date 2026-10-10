# Preserve numeric GitHub search comment counts

## Goal

Keep numeric GitHub issue/PR search rows aligned with text-search rows for comment counts, without per-result hydration or changing the list hot path. Document that text-search PR rows may omit diffstat because adding it would require per-PR lookups.

## Scope

Only `packages/cezar/src/server/forge/github.ts` and its focused unit tests. Non-goals: web/UI, workflow/store/contract, API routes, and unrelated forge behavior.

## Implementation Plan

### Phase 1: Diagnose and pin the regression

- [x] 1.1 Confirm the numeric view field mismatch and add a failing focused test for preserved comment metadata and bounded subprocess calls. — e1134218

### Phase 2: Implement and validate

- [x] 2.1 Use the cheapest bounded metadata path for numeric lookups, update the schema/flattening comments, and keep text-search diffstat limitations explicit. — e1134218
- [ ] 2.2 Run focused tests, the configured validation gate, and review the scoped diff.

## Risks

GitHub CLI JSON fields differ between search and view; the implementation must avoid requesting full comment bodies or adding one lookup per search result. Failures must continue degrading to the existing zero/empty metadata behavior.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Diagnose and pin the regression

- [ ] 1.1 Confirm the numeric view field mismatch and add a failing focused test for preserved comment metadata and bounded subprocess calls.

### Phase 2: Implement and validate

- [ ] 2.1 Use the cheapest bounded metadata path for numeric lookups, update the schema/flattening comments, and keep text-search diffstat limitations explicit.
- [ ] 2.2 Run focused tests, the configured validation gate, and review the scoped diff.
