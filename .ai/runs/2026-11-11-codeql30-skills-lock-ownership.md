# Serialize skills-update lock ownership

Goal: prevent stale skills-update lock contenders and an expired owner from removing a successor lock (CodeQL30).
Source doc: .ai/specs/2026-07-22-automatic-open-mercato-skills-updates.md
Security-Source: open-mercato/cezar:code-scanning:30
Security-Fingerprint: js/file-system-race:packages/cezar/src/skills-update.ts:acquireLock:stale-removal
Engine: om-auto-create-pr (steps: 3, --loop: no)
Claim-Run: 6bb4723b-dfea-43fa-a4e5-60d585d0c0fe

## Scope

One service method and dedicated regressions: serialize acquisition/reclamation/release using the existing proper-lockfile primitive; add an ownership token after the legacy PID/timestamp lines and remove only the matching owner. Keep existing cross-instance exclusion, dead-owner recovery, inclusive two-minute live boundary, cache TTL, fixed npx argv, manual conflict and graceful degradation. The stale age cap remains a liveness bound even for a live PID; this change does not extend it or terminate a superseded npx command.

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
