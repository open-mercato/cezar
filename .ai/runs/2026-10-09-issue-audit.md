# Open issue audit — 2026-10-09

## Goal
Audit open GitHub issues and deliver five independently verified solutions through child-owned PRs.

## Scope and ranking
Snapshot: open-mercato/cezar, 137 open issues, 121 open PRs; main 1a34fe0f. Checked titles, bodies, issue comments and PR issue references. Priority considers impact, current evidence, existing coverage, and independent delivery. No uncovered release blocker was established.

1. #1338 — Windows checks resolve the WSL launcher instead of usable Git Bash. Reporter confirmed Git Bash PATH fixes checks. Child must preserve Bash semantics and use existing installation discovery, or document the verified requirement if automatic discovery cannot be made safe.
2. #926 — screenshots pasted into queued tasks fail; reproduce and trace upload-to-queue delivery before fixing.
3. #1213 — bounded, ranked planner skill catalog reduces repeated prompt cost. Replaces #1077: child established merged PR #1127 canonicalizes legacy receipt identity, and parent confirmed merge and ancestry; no duplicate PR.
4. #1222 — share per-run SSE event/deletion listeners with lifecycle and replay tests. Low-priority structural performance work, not a measured outage.
5. #1220 — request-triggered stale-while-revalidate model catalog. Low priority, concrete acceptance criteria and no new boot probes.

Excluded: #1267/#1300/#1301/#1325 already have fix PRs; #1308 depends on unmerged waits implementation; #515 is an umbrella. Other lower-priority feature requests and claimed/blocked issues were not selected.

## Implementation Plan
### Phase 1: Audit and dispatch
1.1 Audit live issues, coverage and claims; assign disjoint scopes.
1.2 Dispatch four Codex gpt-5.6-luna children, then queued-attachment child when server scope is free.
### Phase 2: Verify and review
2.1 Validate child diffs, PRs and reported tests; retain honest partial/blocker outcomes.
2.2 Dispatch one final read-only review of this branch plus all child PR heads; wait for verdict. No unreviewed merges and no base-branch merges.
2.3 Record PR links, validation limits and final outcome.

## Non-goals
Parent implementation, merging into main, duplicate PRs, changing automation definitions, speculative fixes. Parent only orchestrates; each child owns its plan, implementation, tests and PR using om-auto-create-pr. Children start their fix branches from origin/main so this orchestration document does not contaminate their PRs. At most eight children overall, five planned implementations plus one final review.

## Audit updates
- #1338: draft PR #1341, af633215f8533fd446521ce19acca728dcb900b5. Parent rejected initial import-only red proof; child replaced it with runnable spawn-boundary regression. Isolated typecheck/build/unit/package pass; native Windows and final review remain.
- #1222: draft PR #1342, 4c5fb13f4add2ee74eac841099d235c93651734e at inspection. Isolated dependency installation fixed initial build errors. Current-head CI queued at parent check; prior green is not proof for new head.
- #926: sixth child 63c5efc0-5aa8-4374-baee-5328c8d2d6b6 dispatched; UI/test writes only while SSE sibling holds server.ts. Investigations may read server; edits need explicit scope release. Final review reserved as seventh task.
- #1077: no action needed; PR #1127 merged as e0c372e2 and is an ancestor of main. Child identified legacy revision-bearing receipt keys, demonstrated pre-fix red and current 38-test green. Parent inspected normalization diff and confirmed merge/ancestry; independent tests being rerun. Replacement #1213 owns planner module/tests only. Six implementation/investigation children plus one final review now planned, within limit eight.

## Risks
#1077 may require unavailable historical evidence; #926 may already be fixed. Do not force a fix when reproduction fails. Windows validation on Linux cannot establish native execution. Parent CEZ_API_URL incorrectly points at a dry-run cockpit; verified actual host process, health/project identity and task list at http://172.17.0.1:4321. Use that endpoint for task commands. Model catalog on actual cockpit confirms gpt-5.6-luna.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Audit and dispatch
- [x] 1.1 Audit live issues, coverage and claims; assign disjoint scopes.
- [x] 1.2 Dispatch four Codex gpt-5.6-luna children, then queued-attachment child when server scope is free. — #926 dispatched with UI-only writes pending server release

### Phase 2: Verify and review
- [ ] 2.1 Validate child diffs, PRs and reported tests; retain honest partial/blocker outcomes.
- [ ] 2.2 Dispatch one final read-only review of this branch plus all child PR heads; wait for verdict.
- [ ] 2.3 Record PR links, validation limits and final outcome.
