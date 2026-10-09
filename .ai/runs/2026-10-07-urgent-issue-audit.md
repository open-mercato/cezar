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

## Risks
#1077 may require unavailable historical receipt evidence: do not invent a cause or a fix. UI changes require browser evidence. Full configured gate may expose unrelated baseline failures: report honestly. At most eight child tasks total; planned five fixes and one final review. Four in flight maximum.
Cockpit injected localhost URL points to stale missing-worktree server; verified live service identity and parent tree at http://172.17.0.1:4321. Use per-command CEZ_API_URL override. Live model catalog confirms gpt-5.6-luna.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Independent fixes

- [ ] 1.1 Resolve issue 1301
- [ ] 1.2 Resolve issue 1077
- [ ] 1.3 Resolve issue 926
- [ ] 1.4 Resolve issue 1285
- [ ] 1.5 Resolve issue 949

### Phase 2: Verification

- [ ] 2.1 Validate child reports and PR evidence
- [ ] 2.2 Obtain final independent review verdict and report
