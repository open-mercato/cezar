# Serialize skills-update lock ownership

Goal: prevent stale skills-update lock contenders and an expired owner from removing a successor lock (CodeQL30).
Source doc: .ai/specs/2026-07-22-automatic-open-mercato-skills-updates.md
Security-Source: open-mercato/cezar:code-scanning:30
Security-Fingerprint: js/file-system-race:packages/cezar/src/skills-update.ts:acquireLock:stale-removal
Engine: om-auto-create-pr (steps: 3, --loop: no)
Claim-Run: 6bb4723b-dfea-43fa-a4e5-60d585d0c0fe

## Scope

One service method and dedicated regressions: serialize acquisition/reclamation/release using unique PID/UUID choosing-and-ticket claims; add an ownership token after the legacy PID/timestamp lines and remove only the matching owner. Keep existing cross-instance exclusion, dead-owner recovery, inclusive two-minute live boundary, cache TTL, fixed npx argv, manual conflict and graceful degradation. The stale age cap remains a liveness bound even for a live PID; this change does not extend it or terminate a superseded npx command.

Non-goals: CodeQL31 metadata read (already PR2096), dependencies, other alerts, settings/workflows/HTTP/telemetry/defaults, broad locking refactors. Fix one group only; remaining identities are deferred to later bounded runs. No issue, merge, auto-merge, dismissal or release.

## Implementation plan

### Phase 1: Ownership

1.1 Add guarded lock ownership with real-filesystem race and compatibility regressions; prove the new security tests fail against original source.

### Phase 2: Verification and review

2.1 Run targeted integration/regression coverage and every configured validation command in order; record exact results and limitations on PR.
2.2 Resume the existing final reviewer for the authoritative om-auto-review-pr/om-code-review pass, resolve findings, publish outcome and release owned claim.

## Risks

The guard serializes cooperating upgraded processes. Arbitrary same-user filesystem tampering, hard links and hostile parent directories are outside its guarantee. Old versions ignore the new guard/token: mixed-version races remain possible; legacy live/dead metadata must still be read. Guard failures must degrade without failing boot. CodeQL may continue reporting a pathname check/use despite cooperative serialization; no main-fixed or analyzer-closure claim before merge/rescan.

User continuation authorizes completing this run without another confirmation. The exact installed atomic tracker operations are used for this run (from om-setup-agent-pipeline references/trackers/github.md); repository descriptor/settings/workflows stay unchanged. This is the same atomic protocol, never comment-election fallback. Two subtasks already used: resume final reviewer169d3d3d, do not create a third.

## Progress
PR: #2099

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Ownership

- [x] 1.1 Add guarded lock ownership with real-filesystem race and compatibility regressions — 9994c9fc

### Phase 2: Verification and review

- [ ] 2.1 Run targeted integration/regression coverage and every configured validation command in order
- [ ] 2.2 Resume the existing final reviewer for the authoritative review and publish outcome

Phase1 evidence: final five-case suite against original source via source-only stash exits1 (3failed/2passed), including real peak2 concurrent commands and successor-file ENOENT. Fixed focused suites26/26pass. Typecheck passes. Cross-process exclusion test spawns bounded real Node process with tsx; commands are injected and no real npx/network runs. Full ordered gate underway.

Phase2.1: all5ordered gatesPASS (15327Vitest/51core/34package); see [verification](2026-11-11-codeql30-skills-lock-ownership-verification.md). Final reviewer169d3d3d will be resumed for authoritative implementation review; prior triage-only verdict is not code approval.

## Guard-recovery proof (M1)

Independent review of31297f61 found proper-lockfile4.1.2's own stale stat/rmdir can delete a fresh guard before its heartbeat. The two-process regression reproduces both commands running with neither finished; no hostile tampering, old version or live metadata expiry is required. This supersedes the initial primitive choice; source scope remains the same service and dedicated test, with no dependency change.

The replacement adapts [Lamport's choosing/ticket ordering](https://www.microsoft.com/en-us/research/publication/new-solution-dijkstras-concurrent-programming-problem/) to unique single-writer claim paths. Register an empty choosing slot BEFORE scanning; choose max published ticket+1; atomically publish via own unique staging file. Before entry, wait boundedly for choosing slots to publish, then refuse any lower (ticket,name). Later registrants observe the ready ticket and cannot preempt it. Timeout/busy returns unavailable/conflict; delays affect availability only, never establish exclusion. Cleanup deletes only unique attempt names, which are never reused, so two dead-owner reapers cannot remove a successor's claim.

Normal completion publishes released then removes own claim; another scanner can prune a released record even if its PID lives. Crash/death allows the next scanner to prune that exact PID/UUID claim/staging file. EPERM is live. Unknown cache files are ignored. Empty guard directory remains harmless and reconstructible. A LIVE guard holder is never expired by age: no shared pathname can safely fence a paused writer; its file-only critical section must finish or its PID die. The guard never spans npx. The OLD two-minute METADATA lease expiry, including live-command recovery, remains unchanged and tested. PID reuse can conservatively delay dead-claim cleanup; non-cooperating writers and incoherent/network filesystems are outside this local-process guarantee.

Post-review validation: first M1 typecheck exposed test-helper typing errors, corrected without assertion changes. First broad test rerun hit the untouched Codex143 shutdown fixture; source/test diff against main is empty. Isolated rerun and final ordered gate outcomes recorded in verification. No product/timing-test workaround.

- [x] Post-review fix M1: unique-attempt guard recovery and executable two-process regression — 87fd5ac5

M1 fixed targeted30/30 plus untouched Codex suite35/35 pass together (65total); ordered gate rerunning. Prior implementation review remains changes-requested until the same reviewer approves the new head.
