# Urgent issue audit — 2026-10-07

## Goal
Audit open GitHub issues, delegate five relevant uncovered defects to Codex gpt-5.6-luna children that own root cause, fix, tests and PR creation, then obtain one final independent review. Parent only orchestrates; no base merges.

## Scope and selection
Snapshot: 135 open issues, 110 open PRs. Prioritize broken execution, duplicate work, lost user input, interactive performance, then incorrect navigation. Exclude work already covered by open PRs, blocked dependencies, and fixed defects. #1267 is already fixed in the checked-out test fixture; #1307 and #1308 depend on unmerged #1289. #1287 duplicates #1285.

1. #1301 — parallel worktree creation fails before agents start. Scope git-worktree.ts and its tests.
2. #1077 — duplicate automation launch report. Scope automations implementation/tests; triage disputes revision hypothesis, so verify before changing semantics. No edits to server.ts shared with #926 without serialization and scope reassignment.
3. #926 — queued tasks reject pasted screenshots. Scope attachment/composer flow, server attachment routes and focused tests; exclude forge and diff components.
4. #1285 (also #1287) — range dragging rerenders unrelated diff files. Scope web components/diff and focused tests.
5. #949 — numeric issue search misidentifies PRs. Scope server/forge/github.ts and driver tests. Prefer rejecting wrong-kind lookup and falling through, maintaining tab semantics without UI changes.

## Implementation Plan
Phase 1: dispatch first four independent fix investigations, then fifth as a slot opens. Each child follows om-auto-create-pr, reads issue/comments and competing PRs, claims only unowned work, records its plan before code, tests and reviews its PR, and reports evidence. Children create separate PRs as explicitly requested; no parent implementation PR.
Phase 2: validate every report through PR diff and named tests; request corrections if needed. Dispatch ONE final review task against the parent branch plus explicit child PR heads. Do not merge unreviewed work; independent PRs can remain separate without aggregation merges.

## Latest status

#926 is already covered by merged #1246 (15a7dd1f); parent verified ancestry, read regression diff and reran the exact test (1 passed, 49 skipped). #1117 dispatched as 686ac889-6dad-42f9-9d9b-b6bc57a0f536. Six of eight subtasks used; reserve final review. No invented changes solely to reach a PR count. #1107 also already has condition-based waits on this base and is not a suitable replacement without new evidence.

## Audit update

#1077 is already fixed by merged #1127; ancestry, diff and 38 relevant tests verified by parent. No new PR needed. #1117 is the next unclaimed actionable replacement: recurring automation lease contention CI failure; keep exclusivity proof while making liveness deterministic. #826 is assigned to another owner and excluded. #949 child eef21932-f1c9-4967-b3c5-cf8ca174e14c dispatched (5/8 tasks used); dispatch #1117 when one of four active slots frees. Reserve one slot for final review.

## Risks
#1077 may require unavailable historical receipt evidence: do not invent a cause or a fix. UI changes require browser evidence. Full configured gate may expose unrelated baseline failures: report honestly. At most eight child tasks total; planned five fixes and one final review. Four in flight maximum.
Cockpit injected localhost URL points to stale missing-worktree server; verified live service identity and parent tree at http://172.17.0.1:4321. Use per-command CEZ_API_URL override. Live model catalog confirms gpt-5.6-luna.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Independent fixes

- [ ] 1.1 Resolve issue 1301
- [x] 1.2 Resolve issue 1077 — existing merged fix e0c372e2 independently verified; 38/38 tests pass
- [x] 1.3 Resolve issue 926 — existing coverage 15a7dd1f independently verified; exact queued screenshot test passed
- [ ] 1.4 Resolve issue 1285
- [ ] 1.5 Resolve issue 949

- [ ] 1.6 Resolve replacement issue 1117

### Phase 2: Verification

- [ ] 2.1 Validate child reports and PR evidence
- [ ] 2.2 Obtain final independent review verdict and report
