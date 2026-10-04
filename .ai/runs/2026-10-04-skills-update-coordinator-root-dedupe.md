# Deduplicate skills-update coordinator roots

## Goal

Fix issue #875 so aliases for the same project root do not trigger duplicate skills checks or evict a cache still owned by another alias.

## Scope

- `packages/cezar/src/skills-update.ts`
- `packages/cezar/src/skills-update.test.ts`

Non-goals: changing server project registration, service cache behavior, or unrelated API/server files.

## Implementation Plan

### Phase 1: Coordinator ownership

- [ ] 1.1 Deduplicate queued work by root while retaining every project-id alias.
- [ ] 1.2 Evict a root only after its final alias is removed, including stop cleanup.

### Phase 2: Regression coverage

- [ ] 2.1 Add tests covering duplicate aliases, alias removal, replacement, and preserved lifecycle behavior.
- [ ] 2.2 Run targeted and repository validation gates; review the final diff.

## Risks

The coordinator is asynchronous and lifecycle-driven; root replacement and stop/remove races must continue to suppress stale queued work and clean each cache once.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Coordinator ownership

- [ ] 1.1 Deduplicate queued work by root while retaining every project-id alias.
- [ ] 1.2 Evict a root only after its final alias is removed, including stop cleanup.

### Phase 2: Regression coverage

- [ ] 2.1 Add tests covering duplicate aliases, alias removal, replacement, and preserved lifecycle behavior.
- [ ] 2.2 Run targeted and repository validation gates; review the final diff.
