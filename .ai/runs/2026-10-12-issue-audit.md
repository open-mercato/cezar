# Open issue audit — 2026-10-12

## Goal
Orchestrate five independently published, tested fixes using Codex gpt-5.6-luna, then obtain one final dispatched review. Children create their own PRs; the parent only audits and validates. No base merges.

## Scope and selection
Audited all 120 open issues and 104 open PRs with GitHub CLI. Prioritize uncovered user-facing bugs then actionable bounded performance/test debt. High-priority issues #1267, #798 and #475 already have PRs. #689 has an existing claim; #515 is a split historical umbrella; #1308 depends on unmerged #1289.

1. #1077 automation duplicate launches: investigate receipts and revision edits without assuming the reported theory; ship only a proven correction.
2. #926 queued screenshot failures: preserve attachment delivery before execution.
3. #1237 header overflow: compact child summary; use conservative pane behavior preserving manual expansion.
4. #1216 dispatch lookups: indexed tree/parent lookup preserving delivery semantics.
5. #540 reference tracking: bound hot-path work and close marker persistence test gaps, after #1216 settles to avoid concurrent store edits.

## Non-goals
No feature expansion, claimed-work takeover, automatic base merge, or speculative duplicate-run policy change. No root implementation PR: requested child PRs own each solution.

## Implementation Plan
### Phase 1: Delegate
Dispatch first four disjoint scopes; queue #540 behind #1216. Each child reads om-auto-create-pr, checks claims and PRs, creates its plan and draft PR, proves regression, fixes, tests, reviews and reports.
### Phase 2: Validate
Read every child diff and rerun targeted tests. Dispatch exactly one final review of this parent branch plus all child PR heads. Merge no unreviewed work; keep fixes as separate PRs.

## Risks
#1077 lacks historical receipt evidence and may not reproduce; report uncertainty. UI changes require browser evidence. Model catalog verified gpt-5.6-luna. Inherited API URL points at wrong process; owning cockpit verified at http://172.17.0.1:4321 by project registry and task list. #1216/#540 must run sequentially.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Delegate
- [ ] 1.1 Resolve automation duplicate reports #1077
- [ ] 1.2 Fix queued attachments #926
- [ ] 1.3 Compact subtask header #1237
- [ ] 1.4 Index dispatch lookups #1216
- [ ] 1.5 Bound reference tracking #540

### Phase 2: Validate
- [ ] 2.1 Verify child diffs and tests
- [ ] 2.2 Obtain final dispatched review

## Audit findings

- #1077: no new proven defect; merged #1127 hardened receipt identity. Remains unresolved pending historical evidence. No duplicate PR.
- #1237: header already fixed by #1051. Child draft #1385 preserves manual Agents-dock expansion, pending independent review of scope and behavior; full validation not established.
