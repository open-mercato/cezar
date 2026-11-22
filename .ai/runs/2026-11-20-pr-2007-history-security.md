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


## Scheduled verification continuation (2026-11-20)

Claim-Run: 97c0ede8-d979-466c-8a9d-f14b78f919a3
Claim-Comment: 7040387503
Claim-Lock-SHA: 9f6546d927ce79789801f18d90e83e47876271a2

- [x] 3.1 Merge current main without changing the descriptor-bound reader behavior —42d09356b6fce49ec5a119aa43af8fabb3e312fa.
- [x] 3.2 Repeat removal proof and focused coverage: current-main source fails7/10 dedicated cases; fixed new/existing suites pass41/41.
- [x] 3.3 Run all five configured gates on the integrated product source: typecheck PASS;17773 Vitest tests/8 existing skips PASS (8 workers);54 core PASS;build/check:pack PASS;35 package PASS. The continuation shell stopped on a misspelled log-directory variable after Vitest; the three not-yet-started commands then ran in order with the correct log path. No source, assertions or product configuration changed for that correction.
- [x] 3.4 Re-review the complete scope against repository/skill checklists and inherited feedback; no actionable findings. Publish the resumed PR and complete owned-claim cleanup; tracker completion/CI comments are authoritative for release and new-head CI results.

No duplicate PR, API/transcript/startup/configuration/architecture/dependency or default changes. Existing automerge, skip-qa, risk-low and both backport requests retained. Draft is used while new-head remote verification is pending; ready follows when it passes. Formal GitHub approval remains independent of the author COMMENT. No merge.

## Autonomous verification continuation (2026-11-22)

Claim-Run: e137fdec-0e18-4ed4-aad6-74fccc5782ce
Claim-Comment: 7078924946
Claim-Lock-SHA: f5aad46c3b15cecb2a8101c7915cc391c7bc5913

- [x] Integrate main 957ef017f without changing the existing descriptor-bound reader behavior.
- [x] Repeat regression proof: current main fails 7/10 dedicated cases; fixed new/existing history suites pass 41/41.
- [x] Run the full ordered gate: typecheck PASS; npm test (8 workers) 17,942 passed / 8 existing skips; core tests 54 passed; build/check:pack PASS; packaged CLI tests 35 passed. Only test-process CEZ_INSTANCE_ID and CEZ_ARTIFACTS_DIR are unset; no assertions or application defaults changed.
- [x] Re-review the complete main-relative diff, API consumer and inherited feedback. No remaining actionable finding; metadata/read cleanup and current cursor bookkeeping remain covered. The existing atomic descriptor upgrade is retained without unrelated tooling changes.
- [ ] Publish integrated head, wait for its own CI, then promote draft and release owned claim. Tracker evidence is authoritative for those post-commit steps.

Application startup, configuration, architecture, dependencies, APIs and persisted formats remain unchanged. Existing automerge and release/v0.20.x plus v0.18.x backport requests remain eligible. Formal GitHub approval stays separate from an author COMMENT; no merge.
