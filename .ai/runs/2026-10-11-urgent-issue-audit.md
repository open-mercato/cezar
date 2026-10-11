# Open issue audit — 2026-10-11

## Goal
Orchestrate five independent issue solutions with child-owned investigation, tests and PRs, then obtain one final independent review. User explicitly requests no parent implementation PR; retain separate child PRs and merge nothing into base.

## Scope and selection
Snapshot: 123 open issues, 110 open PRs in open-mercato/cezar. Prioritize commit correctness, operational access, CI reliability, then user-visible latency. Existing priority-high issues have open PR coverage. Exclude already-fixed #926/#1077/#1107/#1234, umbrella #515, unlanded dependencies #1308/#1170, active claims and existing PRs. Rankings are within actionable uncovered work, not a claim that lower-priority optimizations are critical incidents.

1. #1359: check residue in graph commits and retained artifact maps. Scope git-worktree and workflows/run plus focused tests.
2. #1080: terminal CLI operation and documentation. Scope index.ts, automation-cli, task-cli, dedicated runs CLI/helpers/tests, README/reference documentation. Never silently route agent mutations to an unrelated cockpit.
3. #1017: deterministic disabled-automations route test. Scope web/routes.test.tsx and dedicated test support only.
4. #1217: bounded filesystem metadata concurrency. Scope server/fs-browse, git-changes and dedicated helper/tests; no server.ts changes.
5. #1219: interaction-gated skill previews, palette and project dialogs. Scope named web components and their tests/E2E; no routes.test.tsx edits.

## Implementation Plan
Phase 1: dispatch first four to runner codex/model gpt-5.6-luna; fifth when a slot frees. Every child follows installed om-auto-create-pr, checks claims/competing PRs, reproduces before fixing, proves regression tests red/green, runs configured gate and owns PR creation/review/evidence. Do not launch further descendants. Each child uses its own plan path. No invented fixes for already-resolved reports.
Phase 2: parent reads every diff and reruns named tests, then dispatches ONE final review against parent branch and all child heads. Separate child PRs need no aggregation merge. Limit eight total tasks, planned six.

## Audit update

#1080 is partly resolved by merged #1133 (fd99a9d2), present in this checkout. Parent independently reran four CLI suites: 46/46 pass. Cancel/relaunch remain deliberately unresolved, so do not call the entire issue fixed. Child created no duplicate PR. #1219 dispatched as c51ed698; five child slots consumed, four currently active. Select one independent replacement after confirming it remains actionable; reserve final review.

## Risks
Live injected cockpit URL resolves to the wrong process; verified parent tree at http://172.17.0.1:4321, use per-command CEZ_API_URL override. Live model catalog confirms gpt-5.6-luna. Some issues may already be fixed or contain scope questions; children must report evidence and use safe defaults rather than inventing work. Full gate failures remain blockers unless proven baseline. UI changes need browser evidence.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Independent solutions

- [ ] 1.1 Resolve issue 1359
- [ ] 1.2 Resolve issue 1080
- [ ] 1.3 Resolve issue 1017
- [ ] 1.4 Resolve issue 1217
- [ ] 1.5 Resolve issue 1219

### Phase 2: Verification

- [ ] 2.1 Validate child reports and PR evidence
- [ ] 2.2 Obtain final independent review verdict and report
