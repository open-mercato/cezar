# Avoid repeated provider-auth transcript scans

## Goal

Deduplicate `provider-auth-required` markers in observer-owned memory so repeated auth-shaped events do not synchronously reread a run transcript, while preserving markers across store reopening and isolating distinct transcript files.

## Scope

- `packages/cezar/src/server/provider-auth-runtime.ts`
- `packages/cezar/src/server/provider-auth-runtime.test.ts`
- A read-only `RunStore` data-directory accessor only if required to form stable transcript identities.

Non-goals: server routes/SSE, other `RunStore` behavior, contracts, UI, auth latch logic, event shape, disk seeding, live-key eviction, or broad lifecycle changes.

## Implementation Plan

### Phase 1: Observer-owned dedupe

- [x] 1.1 Add stable transcript identity access and observer/cache plumbing; dedupe successful appends with reentrancy rollback and deletion cleanup. — 05dc4b47
- [x] 1.2 Add regression and lifecycle tests for repeat reads, store reopening, incidents, transcript isolation, deletion, rollback, and listener disposal. — 05dc4b47

### Phase 2: Verification and delivery

- [x] 2.1 Run targeted red/green proof and the configured validation gate; perform scoped self-review. — f7ac8c05
- [x] 2.2 Publish the PR with tracking/status metadata, evidence, labels, and limitations. — f7ac8c05

## Risks

The cache must survive `RunStore` replacement without being keyed by store object, and must never reserve a key permanently when an append fails or re-enters synchronously. Production incident IDs are fresh UUIDs after restart, so this intentionally does not seed from disk.

## Progress

PR: #1344 (https://github.com/open-mercato/cezar/pull/1344)

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Observer-owned dedupe

- [x] 1.1 Add stable transcript identity access and observer/cache plumbing; dedupe successful appends with reentrancy rollback and deletion cleanup. — 05dc4b47
- [x] 1.2 Add regression and lifecycle tests for repeat reads, store reopening, incidents, transcript isolation, deletion, rollback, and listener disposal. — 05dc4b47

### Phase 2: Verification and delivery

- [x] 2.1 Run targeted red/green proof and the configured validation gate; perform scoped self-review. — f7ac8c05
- [x] 2.2 Publish the PR with tracking/status metadata, evidence, labels, and limitations. — f7ac8c05
