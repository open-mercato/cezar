# Deduplicate skills-update coordinator roots

## Goal

Fix issue #875 so aliases for the same project root do not trigger duplicate skills checks or evict a cache still owned by another alias.

## Scope

- `packages/cezar/src/skills-update.ts`
- `packages/cezar/src/skills-update.test.ts`

Non-goals: changing server project registration, service cache behavior, or unrelated API/server files.

## Implementation Plan

### Phase 1: Coordinator ownership

- [x] 1.1 Deduplicate queued work by root while retaining every project-id alias. — 19474759
- [x] 1.2 Evict a root only after its final alias is removed, including stop cleanup. — 19474759

### Phase 2: Regression coverage

- [x] 2.1 Add tests covering duplicate aliases, alias removal, replacement, and preserved lifecycle behavior. — 19474759
- [x] 2.2 Run targeted and repository validation gates; review the final diff. — a82c18f8

## Risks

The coordinator is asynchronous and lifecycle-driven; root replacement and stop/remove races must continue to suppress stale queued work and clean each cache once.

## Progress
PR: #1259


> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Coordinator ownership

- [x] 1.1 Deduplicate queued work by root while retaining every project-id alias. — 19474759; validation and independent review completed
- [x] 1.2 Evict a root only after its final alias is removed, including stop cleanup. — 19474759; validation and independent review completed

### Phase 2: Regression coverage

- [x] 2.1 Add tests covering duplicate aliases, alias removal, replacement, and preserved lifecycle behavior. — 19474759; validation and independent review completed
- [x] 2.2 Run targeted and repository validation gates; review the final diff. — 19474759; validation and independent review completed

## Final verification

Implementation source at `19474759` was independently reviewed by dispatch task `9ac8a721`; final verdict approve, no findings. All configured validation commands passed with full-suite evidence on the PR. The completion update changes this plan only; source remains the reviewed version.

Coverage scope clarification for Step 2.1: the added regression covers duplicate aliases and final-alias eviction; existing lifecycle coverage is retained. Replacement and stop behavior were reviewed in the source, without a separate new replacement-specific test.
