# Issue resolver audit — 2026-10-04

## Goal
Audit open GitHub work and delegate five independent, actionable fixes with tested PRs.

## Scope and selection
Snapshot: 139 open issues, 108 open PRs; base main at 1b13522d. Prioritize current user impact and correctness, then repeated CI cost and wasted background work. Exclude existing fixes, active claims, blocked designs and overlapping work. These are the top actionable uncovered candidates, not a claim that low-priority bugs outrank already-owned high-priority work.

1. #1095: draft switch feedback plus confirmed attachment-only destination loss. Scope: web new-task route/draft code and its tests; dedicated UI evidence.
2. #1248: headless Claude permission denials cause futile retries and impossible advice. Scope: runner/system prompt permission guidance and tests, .env.example, docs/reference.md, CODE_REVIEW.md. Preserve permission controls; do not implement the overlapping #475 UI project.
3. #987: first follow-up attachment advertises an ungranted library. Scope: workflow attachment grant/hint lifecycle and tests.
4. #1233: unsupported agent account identity reports OpenCode for pi/Copilot. Scope: agent-config/account-identity.ts and tests. Replaces #1107: direct baseline inspection found its fixed waits already repaired by c791ed9c (#1132); worker must correct initial PR claims and replace supplemental automation diff.
5. #875: duplicate boot-root tracking causes repeated skills work and premature cache eviction. Scope: skills-update.ts and tests; avoid server.ts unless a scope amendment is recorded.

## Implementation Plan
### Phase 1: Delegate
Dispatch four independent implementation children, then the fifth when a slot opens. Each child uses codex / gpt-5.6-luna, owns its issue-specific execution plan, root cause, fix, regression proof, full configured validation, review and PR creation via om-auto-create-pr. No grandchildren: reserve six total children (five implementers, one final reviewer), within eight allowed.
### Phase 2: Validate and review
Inspect every child's diff and reported evidence, rerun targeted verification. Leave fixes on their individual PR branches. Dispatch exactly one final review child against the orchestration branch, with explicit instructions also to inspect all five PR heads and the audit decisions. Merge no branch without prior review; no integration merge is needed for five independently deliverable PRs.

## Non-goals
No base merges, unrelated fixes, permission bypasses, speculative broad feature implementation, or duplicate fixes for work already in open PRs. Parent only orchestrates; children create PRs as explicitly requested.

## Risks
Full gates run on a shared host and may encounter unrelated flakes. Report evidence and limits honestly. Supplied CEZ_API_URL hit an unrelated test cockpit; verified owning cockpit at http://172.17.0.1:4321 via project registry and task list. Local Codex model catalog lists gpt-5.6-luna. UI work requires browser evidence.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Delegate
- [x] 1.1 Audit open issues and PRs; select independent candidates
- [x] 1.2 Dispatch five issue-specific PR implementers

### Phase 2: Validate and review
- [ ] 2.1 Validate five reports and targeted tests
- [ ] 2.2 Dispatch and await one final independent review
- [ ] 2.3 Report PR outcomes and unresolved limits

## Dispatch record

#1095 bd164496 → PR #1255 (worker session stopped after final handoff to free capacity; changes preserved). #1248 07a28baf → PR #1256. #987 cfdc5132 → PR #1257. #1233 034cf8af → repurposed PR #1258 after stale #1107 rejected. #875 0f80244c dispatched fifth. All codex/gpt-5.6-luna. Five subtasks used; final reviewer remains reserved.
