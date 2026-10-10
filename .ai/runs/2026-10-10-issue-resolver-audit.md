# Issue resolver audit — 2026-10-10

Goal: deliver independently diagnosed, tested PRs for five actionable open bugs. Parent only orchestrates; children own PR creation. No merges into main and no unreviewed child merges.

Audited 124 open issues and 104 open PRs on main 59ba4ea7. Higher-severity #798, #475, #689, #882, #1300 already have open fixes. #1267 is fixed in main (no-such-runner fixture). #1077 needs missing run evidence and its revision-key hypothesis is disproven in comments; avoid speculative remediation.

Selected in impact order among uncovered actionable issues:
1. #926 queued screenshot paste fails: user input delivery, scope attachment/message queue code and focused tests.
2. #1237 overflowing subtasks header: blocks transcript on smaller screens; scope run-header/agents-dock components and tests. Choose reversible compact overflow; collapse Agents dock on completion transition but allow manual reopening; document ambiguous step-rail portion, do not invent a closure claim.
3. #1107 automations boot test race: repeated CI failures; scope automations-gate.test.ts only.
4. #1017 disabled-automations route timing: repeated CI failures; scope routes.test.tsx only.
5. #826 obsolete thread-scroll expectations: restore useful browser regression coverage; scope thread-scroll.e2e.ts only.

Each child must confirm still unfixed and no active claim/covering PR, read issue comments, use installed om-auto-create-pr, commit plan first, reproduce and prove regressions, run configured validation, independently review per skill, open/update its own PR and report exact evidence. No feature work, base merges or speculative fixes. Shared files require coordination.

Dispatch: Codex runner / gpt-5.6-luna, maximum four active children, five implementation children plus ONE final read-only review of parent branch and child PR heads. No cost limit invented. Parent validates diff and focused tests, retains separate PRs rather than combining unrelated fixes.

Risks: stale issue reports may warrant no-change evidence; existing CI failures and browser setup may block full verification. Never call partial complete.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Audit and dispatch

- [x] 1.1 Audit issues against open PRs and current main
- [x] 1.2 Dispatch five independent fixes with child-owned PRs — seven implementation investigations dispatched; stale issues required replacements

### Phase 2: Validate and review

- [ ] 2.1 Validate child reports and focused test evidence
- [ ] 2.2 Dispatch one final review and await verdict
- [ ] 2.3 Report PRs and remaining verification limits

## Audit corrections and current outcome

- #926 already fixed by merged #1246; parent verified ancestry and exact queued screenshot test (1 pass).
- #1107 already fixed by merged #1330; parent verified ancestry and suite (22 pass).
- #1017 already fixed by suite-level preload; child passed exact main test (132 pass) and closed unnecessary #1351. No merge.
- #1237 remaining AgentsDock collapse: draft #1350; parent reviewed diff and passed 18 focused tests. Header overflow already fixed in #1051.
- #826 browser regression update: draft #1352; browser execution and final review still pending.
- Replacement #545 preserves per-step model attribution, child 667c7eca.
- Replacement #889 preserves numeric GitHub search comment counts without N+1 lookups, child 74445cfa.

Seven implementation children used; exactly one final review slot remains. No merges. Final review must cover child PR heads, since parent branch holds orchestration evidence only. Generated-type failures were traced by #1017 to cross-worktree dependency links and recovered with a local locked install; other children notified.
