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

### Phase1: Already landed

- [x] 1.1 Bind history sizes/reads to one descriptor and cover replacement/disappearance —33ff21c436e234162e2947f19eddc04f6f1d79a2

### Phase2: Security continuation

- [x] 2.1 Integrate latest main and extend metadata/read-failure cleanup coverage —a5374494229587385b221fe6692baea22db60434
- [ ] 2.2 Prove regressions red on main and run all five configured npm gates
- [ ] 2.3 Review, refresh evidence and labels, and release the PR claim

Evidence: current main fails7/10 dedicated regressions; the fixed reader plus existing history suite pass41/41. Source frozen before the full gate.
