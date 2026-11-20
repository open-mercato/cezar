# Execution plan — descriptor-bound history reads (adopted from PR #2007)

Origin: reconstructed by om-auto-continue-pr on2026-11-20 because this PR has no tracking plan.
PR: #2007 · Branch: cez/c0e0a50a · Base: main
Author: open-mercato-maintenance[bot]

## Goal

Complete the existing #2005 security fix: transcript size and reverse reads use the same opened descriptor, with cleanup on every exit.

## Scope

The two event-history readers, their dedicated regressions, latest-main integration and verification. Existing pipeline descriptor changes stay within their original scope.

## Non-goals

No duplicate PR, merge, application startup/configuration/architecture change, API/transcript migration, or request-wide snapshot isolation.

## Evidence

| Conclusion | Drawn from | Confidence |
|---|---|---|
| Open/stat through one descriptor closes the reported race | Issue2005; existing reader diff | high |
| Replacement, disappearance, empty and metadata cases already exist | event-history-race.test.ts;33ff21c4 | high |
| Current-main verification is due; both readers need failure-path coverage | Issue cleanup acceptance; previous review5908227708; current diff | high |

## Assumptions

Preserve the implemented approach and add narrow cleanup guards rather than redesign history. Local execution supplements fresh CI; formal approval remains independent of the author bot.

## Risks

History cursors/endOffsets/liveCursor and old transcripts must retain their contract. The latest release/v0.20.x still contains the vulnerable stat-before-open path, so request its backport while preserving the existing v0.18.x request.

## Progress

> Convention: - [ ] pending, - [x] done. Commit SHAs record completed steps.

### Phase 1: Already landed

- [x] 1.1 Bind history sizes/reads to one descriptor and cover replacement/disappearance — 33ff21c436e234162e2947f19eddc04f6f1d79a2

### Phase 2: Security continuation

- [x] 2.1 Integrate latest main and extend metadata/read-failure cleanup coverage — a5374494229587385b221fe6692baea22db60434
- [x] 2.2 Prove regressions red on main and run all five configured npm gates — code9fd5f37e6;17,649 Vitest/54 core/35 package, typecheck and build/check:pack pass.
- [x] 2.3 Review, refresh evidence and labels, and release the PR claim — no remaining code findings; final publication/claim release and fresh CI are recorded in PR comments.

Evidence: current main fails7/10 dedicated regressions; the fixed reader plus existing history suite pass41/41. Source frozen before the full gate.

Claim-Run: 811669fd-e827-49aa-ae6f-a3173dfcf698
Claim-Comment: 7025683891
Claim-Lock-SHA: 895ddf2d7c0932d79b90649601c115a6822e6748

Final scope review: keep only the atomic claim/reset/leased-release descriptor additions needed by the chain; remove unrelated inherited merge-policy and approval examples. Runtime source/test files are unchanged after the successful gate. Final CI still gates ready/merge; the author bot cannot supply formal approval.
