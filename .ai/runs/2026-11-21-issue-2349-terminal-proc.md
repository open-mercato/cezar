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
No UID filter: elevated descendants are in scope because of ancestry. No global ps fallback on Linux. Missing relationship reads return unknown; existing shutdown fallback remains. Preserve macOS ps path. Shutdown wraps sync proc calls in a killable Node helper with the existing 1.5-second subprocess bound and validates JSON through Zod. Other all-user scanners remain. Live privileged/hidepid evidence unavailable until explicitly tested. Parent forbids extra workers, so independent-agent review is unavailable and must be disclosed.

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
- [x] 1.1 Add shared bounded descendant traversal and tests
- [x] 1.2 Route Linux foreground and shutdown reads
### Phase 2: verification
- [x] 2.1 Prove red/green and run all validation commands
- [ ] 2.2 Review, publish and release owned claims

## Implementation evidence
Both production reader regressions fail on actual ps invocations when only routing source files are stashed; restored helper tests pass. Terminal suite: 14 files, 160 tests passed. Source typecheck passed after fixing the live test to keep command rows separate from shutdown rows. Live strace: no ps execution or global /proc listing; numeric process paths limited to root and its descendants. Full first gate: typecheck0, npm test124 (600-second timeout; projects-api protected-shape failure seen before implementation), test:unit0, build0, test:package0 (35 tests). Final rerun underway; the draft must remain until its evidence is complete and blockers resolved.

## Final handoff
All five configured npm commands have passing local results: typecheck0 after a test-only typing correction; npm test0 with command-local CEZ_INSTANCE_ID removal (17831 passed /8 skipped,1093 files passed/3 skipped,875.90s); test:unit0(54); build0 including check:pack; test:package0(35). Prior two full tests reached600s and exited124; the inherited health-key mismatch passes after command-local isolation, without editing health source/config. Source CI at afc46dd91:14 checks complete(12success2skip),11 observed workflow runs complete(2success9skip). Parent independently reported4 files/28 tests passing and inspected the diff.

Remaining step2.2 is gated on native setuid/hidepid QA and independent approval. Parent directs a partial handoff, draft/no-automerge despite passing code gates. The run publishes evidence and releases only its own PR lock after this commit; tracker claim comments record final release. Spec stays design-only on #2370; implementation is #2371. No source changed after afc46dd91. See .ai/analysis/2026-11-21-issue-2349-validation.md and cockpit Assets for exact logs and limits. No further full reruns are planned.

## Root completion after autonomous continuation

- [x] Independently reproduce native setuid ancestry and hidden proc semantics in network-disabled Linux containers. hidepid=0 retains the elevated child and user grandchild. hidepid=1 returns unknown. hidepid=2 exposed a false-idle bug: ENOENT was mistaken for process exit.
- [x] Prove the new hidepid=2 regression red on the previous source, then recheck the parent's children link before ignoring a missing child; actual exits remain skippable and live hidden descendants return unknown.
- [x] Re-run all five configured gates (17,832 Vitest / 54 core / 35 package), native privilege/access checks and real-browser QA on corrected source d868b7b52. Root review resolves the native-QA and hidepid=2 findings. Controlled publication/labels and exact-head CI handoff are recorded in PR comments; formal approval remains protected.

The root owns atomic PR2371 claim under run bab16231-b24e-4b5b-a184-ac255f19a607. Existing #2005 fix PR2007 is the second security candidate; Windows #2368 remains unchanged because a native Windows environment is unavailable. No additional workers were dispatched.
