# GitHub PR merge box and guarded merge

## Overview

Implement the merge-readiness and guarded merge workflow specified in `.ai/specs/2026-07-25-github-pr-merge.md`.

Source doc: .ai/specs/2026-07-25-github-pr-merge.md

## Goal

Give the PR Conversation view an authoritative GitHub-shaped merge box and an explicitly confirmed, expected-head guarded merge action.

## Scope

- Extend the forge boundary with normalized merge state and guarded merge operations.
- Add project-scoped merge-state and merge routes with cache, validation, parity, and invalidation.
- Add the responsive and accessible merge box, method selection, confirmation, and stale-state reconciliation.
- Cover server, UI, dry-run, and browser flows.

## Non-goals

- Auto-merge, merge queue, admin bypass, branch updates, conflict resolution, branch deletion, or editable merge messages.
- Review authoring or the separate Changes tab.
- A local recreation of GitHub's rules engine.

## Risks

- GitHub GraphQL and REST fields evolve; schema drift must degrade to unknown and never enable merge.
- Merge is an upstream mutation; fresh state, expected-head comparison, and duplicate-submit protection are mandatory.
- Cache invalidation must stay project-local.

## Implementation Plan

### Phase 1: Authoritative read model

1. Add merge-state/check/method schemas, forge types, normalization, and fixtures.
2. Add the cached driver operation and project-scoped GET route with validation, parity, isolation, and refresh coverage.
3. Add the read-only merge box with detailed status, checks, blockers, branches, methods, guarded links, responsive layout, and accessibility.

### Phase 2: Guarded mutation

4. Add strict merge input validation, fresh expected-head preflight, sanitized GitHub mutation mapping, and an in-flight guard.
5. Add the project-scoped POST route, error mapping, cache invalidation, origin protection, and cross-project tests.
6. Add method selection, confirmation/focus behavior, mutation reconciliation, duplicate-submit prevention, and query invalidation.

### Phase 3: End-to-end verification

7. Extend dry-run and browser coverage for ready, confirmed merge, stale rejection, blocked state, and mobile; run the full validation gate.

## Progress

PR: #662

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Authoritative read model

- [x] 1.1 Add merge-state/check/method schemas, forge types, normalization, and fixtures. — 7b9af684
- [x] 1.2 Add the cached driver operation and project-scoped GET route with validation, parity, isolation, and refresh coverage. — 7b9af684
- [x] 1.3 Add the read-only merge box with detailed status, checks, blockers, branches, methods, guarded links, responsive layout, and accessibility. — 7b9af684

### Phase 2: Guarded mutation

- [x] 2.1 Add strict merge input validation, fresh expected-head preflight, sanitized GitHub mutation mapping, and an in-flight guard. — 7b9af684
- [x] 2.2 Add the project-scoped POST route, error mapping, cache invalidation, origin protection, and cross-project tests. — 69bf1b2a
- [x] 2.3 Add method selection, confirmation/focus behavior, mutation reconciliation, duplicate-submit prevention, and query invalidation. — 7b9af684

### Phase 3: End-to-end verification

- [x] 3.1 Extend dry-run and browser coverage for ready, confirmed merge, stale rejection, blocked state, and mobile; run the full validation gate. — 550507c3
- [x] Post-review fix: block unknown review/protection state and make manual refresh authoritative. — 30a5acc0
