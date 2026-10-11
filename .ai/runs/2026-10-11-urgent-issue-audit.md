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

## Review checkpoint

#1017 child opened #1368 at ae65fae5 but parent did NOT accept completion: the only test diff removes two timeout overrides, while lazy preloading was already in base. Full gate is red without demonstrated baseline comparisons. Parent sent corrections to child: restore draft/in-progress, prove remaining defect or close duplicate, execute installed review skill as instructions. #575 is the replacement sixth implementation dispatch (fb989476), scoped to capabilities IPv4-mapped IPv6 parsing/tests. Seven tasks including reserved final review; one spare remains. No changes merged.

## Validation follow-ups

#1367 at 0ca8230d and #1369 at e9f0d580 inspected. Parent requested source-lifecycle proof for archive/forget cleanup in #1367; existing helper-only test does not prove later archival triggers cleanup. Both children must rerun gate with TMPDIR=/tmp because injected repo-local TMPDIR invalidates non-repository fixtures. #1369 additionally needs callsite concurrency proof rather than only helper tests. Continued existing children via documented POST /runs/:id/continue (same run and requested model; no new subtasks), including #1017 to close duplicate #1368 after ancestry d22659e8 confirms existing preload. Five actual deliverables still intended: #1359, #1217, #1219, #575, and next replacement #1194 (accessible transcript copy, medium priority, no existing claim/PR); dispatch #1194 when slot frees as task 7, final independent review as task 8. No spare beyond these.

## Duplicate correction

#1368 is closed as no-action-needed: child confirmed preloading was introduced in d22659e8, ancestor of main, and both unchanged-base and proposed timeout-removal variants pass 4 focused tests. Child corrected body/comments and returned reject, not approve. No branch deleted and no source change accepted. The original #1017 issue remains open for tracker housekeeping outside this run.

## Current dispatch and evidence

Seven of eight child slots used; #1194 dispatched as d2316b99 with exclusive shared transcript copy-control scope. Reserve task eight for ONE final independent review. #1369 final head20eb53a6 changes only plan status from verified code a000caf1; PR is ready, parent91/91 tests, full CI38101698905 passed. #1370 at be162f9a has browser screenshots for palette/local-dialog only; parent requested missing first-use preview boundaries in BOTH entry points, real same-base/primary-only/final measurements, broader interaction tests/browser evidence and inline screenshots. Do not accept historic incomparable byte counts as improvement proof. #1367 is still refining cleanup to store events; await final head.

## Risks
Live injected cockpit URL resolves to the wrong process; verified parent tree at http://172.17.0.1:4321, use per-command CEZ_API_URL override. Live model catalog confirms gpt-5.6-luna. Some issues may already be fixed or contain scope questions; children must report evidence and use safe defaults rather than inventing work. Full gate failures remain blockers unless proven baseline. UI changes need browser evidence.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Independent solutions

- [ ] 1.1 Resolve issue 1359
- [x] 1.2 Resolve issue 1080 — no duplicate change: merged partial fix fd99a9d2 verified, 46 CLI tests pass; cancel/relaunch remain open
- [x] 1.3 Resolve issue 1017 — existing preload d22659e8 verified, 4 tests pass; duplicate PR1368 closed
- [x] 1.4 Resolve issue 1217 — 20eb53a6; PR1369 ready, 91 parent tests and full CI pass
- [ ] 1.5 Resolve issue 1219
- [ ] 1.6 Resolve replacement issue 575
- [ ] 1.7 Resolve replacement issue 1194

### Phase 2: Verification

- [ ] 2.1 Validate child reports and PR evidence
- [ ] 2.2 Obtain final independent review verdict and report
