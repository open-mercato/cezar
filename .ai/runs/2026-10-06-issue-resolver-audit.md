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
- [ ] 1.1 Rank five actionable uncovered defects with disjoint scopes
### Phase 2: Delegate
- [ ] 2.1 Dispatch five implementation children
### Phase 3: Verify
- [ ] 3.1 Validate child reports and evidence
- [ ] 3.2 Obtain final independent review and report

## Audit verification
The first audit report is not accepted: #997 is covered by #1154, #1001 by #1174, and #1077 is discussed in #1127 with contrary root-cause evidence. Assignee-only conflicts must follow ANY-signal claim rules, not an all-three requirement. #870 belongs to another assignee and needs explicit stale-lock evidence before takeover. Commission a corrected read-only audit (second child); retain #890 as a candidate. Eight-task allowance now reserved as two audits, five implementers, one final reviewer.
