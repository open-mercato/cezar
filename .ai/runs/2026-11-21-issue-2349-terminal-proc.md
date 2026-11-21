# Terminal descendant proc hardening (#2349)

Source doc: .ai/specs/2026-11-21-issue-2349-terminal-proc.md
Spec PR: https://github.com/open-mercato/cezar/pull/2370
Issue: https://github.com/open-mercato/cezar/issues/2349
Engine: om-auto-create-pr (steps: 4, --loop: no)

## Goal and scope
Avoid unrelated Linux proc accesses from terminal foreground/shutdown readers without dropping setuid descendants. Only server/terminal plus uniquely named #2349 run/spec evidence. No core runners, tracker/config, startup, public contracts or other process scanners. Spec stays design-only on its separate branch.

## Implementation Plan
### Phase 1: scoped Linux reads
1. Add shared bounded descendant traversal, async/sync drivers and access-boundary tests.
2. Route Linux foreground and shutdown reads through it; preserve null, cache and lifecycle semantics.
### Phase 2: verification
3. Prove regression red without source routing and green with it; run terminal lifecycle and all five npm gates.
4. Review through om-auto-review-pr/om-code-review; publish draft on incomplete evidence, preserve QA gates and release owned locks.

## Risks and decisions
No UID filter: elevated descendants are in scope because of ancestry. No global ps fallback on Linux. Missing relationship reads return unknown; existing shutdown fallback remains. Preserve macOS ps path. Local sync proc calls are bounded between operations, not preemptible within a syscall. Other all-user scanners remain. Live privileged/hidepid evidence unavailable until explicitly tested. Parent forbids extra workers, so independent-agent review is unavailable and must be disclosed.

## Claim and validation state
Claim-Run: 3b137dce-0c30-43f0-a1f5-ec9378d2aec7
Claim-Lock: refs/om-locks/issue-2349
Claim-Lock-SHA: 922418d9da5bb252b5969dfe1498bfa325c4e8e5
Claim-Comment: 7053717226
Actor: open-mercato-maintenance[bot]
Bot-specific assignee request was explicitly forbidden (403); no assignee changed.
Initial five-command gate executed before dependencies existed: typecheck 127, npm test 127, test:unit 1, build 127, test:package 1. npm ci then completed. Baseline rerun: typecheck 0; full npm test has projects-api protected-shape failure observed before implementation. Final full results pending.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: scoped Linux reads
- [ ] 1.1 Add shared bounded descendant traversal and tests
- [ ] 1.2 Route Linux foreground and shutdown reads
### Phase 2: verification
- [ ] 2.1 Prove red/green and run all validation commands
- [ ] 2.2 Review, publish and release owned claims
