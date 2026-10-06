# Issue resolver audit — 2026-10-06

## Goal
Select the five most urgent actionable open GitHub defects and delegate root cause, fixes, tests and separate PR creation to Codex gpt-5.6-luna children.

## Scope
Audit all open issues against existing PRs, main and active claims. Parent orchestrates only. Children own independent fixes and their PRs. A final independent review checks the orchestration branch and all child PRs before the final report. No merges into main, no duplicate fixes, no unrelated features.

## Implementation Plan
### Phase 1: Audit
1.1 Rank five actionable uncovered defects with disjoint scopes; exclude already fixed, claimed and covered work.
### Phase 2: Delegate
2.1 Dispatch up to five implementation children (four concurrent maximum), each creating and validating its own PR.
### Phase 3: Verify
3.1 Validate child reports and their changed files/test evidence without merging unreviewed changes.
3.2 Dispatch one final review child against the parent branch, covering the child PR heads; wait for verdict and report.

## Risks
Issue labels can be stale; urgency ranking is provisional until source verification. Existing PRs may cover reports without closing keywords. At most eight children total, including audit and final review. No model substitution: live catalog confirms gpt-5.6-luna. Dispatch CLI needs CEZ_API_URL=http://172.17.0.1:4321 on this host (observed serve bind address); inherited loopback URL refuses connections.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Audit
- [x] 1.1 Rank five actionable uncovered defects with disjoint scopes — audited at 02634469
### Phase 2: Delegate
- [ ] 2.1 Dispatch five implementation children
### Phase 3: Verify
- [ ] 3.1 Validate child reports and evidence
- [ ] 3.2 Obtain final independent review and report

## Audit verification
The first audit report is not accepted: #997 is covered by #1154, #1001 by #1174, and #1077 is discussed in #1127 with contrary root-cause evidence. Assignee-only conflicts must follow ANY-signal claim rules, not an all-three requirement. #870 belongs to another assignee and needs explicit stale-lock evidence before takeover. Commission a corrected read-only audit (second child); retain #890 as a candidate. Eight-task allowance now reserved as two audits, five implementers, one final reviewer.

## Selected independent work
Ranked among uncovered, actionable work (higher-severity reports are already covered or fixed):
1. #701: real-process test teardown/liveness across named server suites; affects trust in validation. Scope excludes auto-resume and GitHub UI tests.
2. #804: auto-resume teardown and GitHub template-stacking tests; recent CI recurrence October 2. Scope only those two suites.
3. #890: non-root browser dependency fallback; blocks UI QA. Already dispatched to 7caa29a8.
4. #894: Pi configuration catalog and Settings descriptor missing despite supported runner. Scope catalog/Pi settings and descriptor/section tests.
5. #870: narrow model-picker description clipping. Scope picker-pill component/tests only. Foreign assignee wojciechszyjka last activity August 11 (assignment/labels, no comments, no covering PR); use transparent stale-lock recovery under claim-pr.md and restore assignee on handback.

Corrected audit was partially accepted: #894/#701 evidence checked; #1007 rejected because #1128 already fixes it. Parent independently searched all 121 PR bodies/titles for numeric issue references and inspected source and live issue metadata for these five. #804 has recent recurrence evidence but must reverify each half before changing it; no artificial defect or weak test allowed. All implementers must recheck coverage/claims immediately before work.
