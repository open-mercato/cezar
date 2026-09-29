# Task PR reference list — #779

Goal: preserve every authoritative PR association on a run and expose the ordered list to the
cockpit while keeping old scalar fields readable.

Scope: `packages/cezar/src/runs`, `packages/contract/src/runs.ts`, and the web task-reference
selector/tests. Non-goals: workflow/server route edits, PR-state hydration, issue references.

## Progress

### Phase 1: persistence and selector

- [x] 1.1 Add additive `prRefs` schema and store projection — d001db66
- [x] 1.2 Record marker/created/legacy associations and regression tests — d001db66
- [x] 1.3 Expose ordered references to web consumers and add selector tests — d001db66
- [ ] 1.4 Run configured validation gate and publish PR
