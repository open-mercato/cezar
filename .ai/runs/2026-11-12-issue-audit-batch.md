# Issue audit batch — 2026-11-12

Goal: pick the 10 most relevant/urgent open GitHub bugs that have **no open PR yet** and ship a fix PR for each through dispatched children (Sonnet 5.5).

## Audit
Open bugs already covered by an open PR were excluded (#2115, #2105, #2103, #2102, #2101, #2100, #2097, #2094, #2092, #2057, #2036, #2006, #2005, #2001, #1988, #1959, #1957, #1956, #1945, #1936, #1929, #1922, #1704, #1622, #1601, #1579, #1540, #1499, #1486, #1338).
Skipped: #1485 (fixed by #1660), #1382 (not reproducible), #2095 (duplicate of #1752, PR #1754), #1493 (vague; PRs #1135/#1491 cover it).

Selected (priority/risk from labels):
| # | Issue | Child |
|---|-------|-------|
| 1 | #1958 OM skills update fails on Windows (npx.cmd spawned directly) | A |
| 2 | #1905 Skills card says "not tracked" when skills are up to date | A |
| 3 | #1948 npm-installed Codex not detected on Windows | B |
| 4 | #1919 Gemini runner drops additionalDirectories | B |
| 5 | #2037 Asset cards not at their chronological place | C |
| 6 | #1923 Agent links gitignored files that are unreachable | D |
| 7 | #1977 Accent ignored on New Task page | E |
| 8 | #1308 User create-and-wait sends no notice | F |
| 9 | #1735 Task with three screenshots returns 413 (staging-failure path) | G |
| 10 | #1920 Artifact images fail behind Host-rewriting proxy | G |

Non-goals: features, issues with open PRs, merging anything.

## Outcome
PRs: #2129 (#1958+#1905), #2132 (#1948), #2134 (#1919), #2133 (#2037), #2131 (#1923, step 1 only — tooltip part open), #2136 (#1977), #2135 (#1920).
#1308 blocked: WaitResolver exists only on unmerged fork PR #1289. #1735 no change: every triaged path already handled on main; needs reporter detail.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Dispatch and validate

- [x] 1.1 Dispatch children A–D
- [x] 1.2 Dispatch children E–G
- [x] 1.3 Validate each child report and its PR
- [ ] 1.4 Final review task verdict
