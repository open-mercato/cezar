# Runner model catalog cache policy

Status: complete

## Goal

Implement issue #1220: keep the existing five-minute freshness window, serve a healthy catalog immediately for up to one hour from its last successful discovery, refresh once in the background on demand, and preserve the last-success age across failures with a five-minute retry cooldown.

## Scope

- `packages/cezar/src/core/runner-model-catalog.ts`
- `packages/cezar/src/core/runner-model-catalog.test.ts`

Non-goals: boot probes, timers, persistence, API/UI shape changes, and runner discovery changes.

## Root cause

The cache had one `expiresAt` value serving both the five-minute refresh deadline and the usable-data deadline. Once it elapsed, every caller awaited discovery even when a healthy prior catalog was available.

## Implementation plan

1. Separate refresh/cooldown timing (`refreshAfter`) from the one-hour last-success usable deadline (`expiresAt`).
2. Return healthy soft-expired catalogs immediately and start one request-triggered single-flight background refresh.
3. Preserve the previous successful deadline on refresh failure, retain the last models, and retry after the existing five-minute cooldown.
4. Add fake-clock coverage for exact boundaries, concurrent callers, background failure, and absent catalogs.

## Verification

- Red regression: with the implementation reverted while retaining the new tests, the two soft-expiry tests failed by timeout.
- Green: scoped catalog/API tests passed (20 tests).
- Green: `TMPDIR=/tmp npm run typecheck` passed after isolated `npm ci --ignore-scripts`.
- Green at the original code head: CI Unit/build/E2E/package, CodeQL, npm snapshot publish, and license/CLA checks passed.
- Full local `npm test` has one unrelated existing `agent-profile-wiring.test.ts` assertion failure under the corrected temp directory.

## Progress

PR: #1343 (https://github.com/open-mercato/cezar/pull/1343)

> Retrospective plan: this plan was not committed before implementation; no history is being manufactured.

### Phase 1: Cache policy

- [x] 1.1 Implement separate freshness and usable windows — `7d186fa0d6e7923aefc1a01245a31265efffc884`
- [x] 1.2 Add boundary, concurrency, failure, and absent-catalog tests — `7d186fa0d6e7923aefc1a01245a31265efffc884`

### Phase 2: Verification and handoff

- [x] 2.1 Run red/green regression and scoped validation — evidence recorded in PR #1343
- [x] 2.2 Complete self-review and hand off for independent review — self-review found no findings; GitHub cannot accept self-approval
