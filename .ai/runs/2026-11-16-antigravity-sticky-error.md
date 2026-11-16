# Antigravity runner: ignore conversation-sticky result ERROR on continued turns

## Goal

Prevent Cezar from failing a successful Antigravity turn when `agy` reports a conversation-cumulative `status: "ERROR"` from an earlier transient error that `agy` already recovered from.

## Scope

- Packages: `packages/cezar`
- Affected files:
  - `packages/cezar/src/core/antigravity-ui-mapper.ts`: track whether a turn made progress (`turnProgressed`) and whether an error step is active (`turnErrorOpen`); treat a `result` ERROR as stale/recovered when progress occurred and no open error step exists.
  - `packages/cezar/src/core/antigravity-ui-mapper.test.ts`: test suite coverage for sticky error resume, error as last word, and progress after error.
  - `packages/cezar/src/core/__fixtures__/antigravity/sticky-error-resume.*`: live captured fixture with redacted IP addresses.

## Non-goals

- Modifying the underlying `agy` CLI binary or its internal session logging.
- Altering error reporting for genuine turn failures (turns that fail before making progress or end on an open error step).

## Implementation Plan

### Phase 1: Mapper fix and test fixtures

1.1 Update Antigravity UI mapper to ignore conversation-sticky result errors
1.2 Add sticky-error-resume golden fixture and unit tests

## Risks

- An error occurring after partial progress could be treated as stale if `agy` does not emit an explicit error step; however, genuine failures with no progress or ending on an error step continue to fail the turn as expected.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Mapper fix and test fixtures

- [ ] 1.1 Update Antigravity UI mapper to ignore conversation-sticky result errors
- [ ] 1.2 Add sticky-error-resume golden fixture and unit tests
