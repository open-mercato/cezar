# Patched Node HTTP adapter

## Goal
Remove the vulnerable Node adapter resolution for Dependabot68 (GHSA-rmxm-3fg6-px4f) while preserving the existing local server and supported Node20 baseline.

## Scope
One coupled dependency remediation group: service manifest, root lock, targeted static-middleware regression and real-loopback adapter integration coverage. Use first patched adapter2.1.3, whose documented public API/Node20/Hono4 requirements fit cezar. Any lock updates must be restricted to this dependency. Existing PR1253 only reaches vulnerable1.19.18 and does not cover alert68; leave that PR unchanged. Removing the old adapter also clears older alert18, already tracked by PR1253.

Non-goals: no other dependency groups, Rust changes (Cargo unavailable), settings/workflow/descriptor/env/API/state changes, issues, merge, auto-merge, releases or dismissals.

Security-Source: open-mercato/cezar:dependabot:68
Security-Fingerprint: GHSA-rmxm-3fg6-px4f:@hono/node-server:package-lock.json

## Implementation Plan
### Phase1: Minimal upgrade and proof
1.1 Upgrade the adapter and add malformed-path regression plus loopback integration coverage; show security regression red on old adapter and green after upgrade.
### Phase2: Validation
2.1 Run all five ordered configured npm gates, resolution/audit checks and applicable static/server integration suites.
### Phase3: Independent review and publication
3.1 Reuse the existing final-review task for the authoritative om-auto-review-pr pass, preserving the two-subtask total; fix findings and reverify until approved.
3.2 Refresh deduplication/claims, finish the PR evidence and labels, release exact owned lock and promote only with complete validation/independent approval.

## Risks and decisions
The adapter major includes optimized request/response internals; real HTTP body/header/stream and packaged CLI gates cover the compatibility boundary. Security behavior intentionally rejects residual percent paths; normal spaces/Unicode and ordinary public files remain covered. No claim that cezar currently exposes private files through this upstream flaw. Alert removal is proved from the installed graph and regression, not baseline-tolerant CI.

The operator explicitly resumed autonomous implementation after the descriptor blocker report. Apply the exact already-installed canonical atomic claim helper in a run-local artifact, plus configured label guards, without editing repository descriptors/settings/workflows. Preserve create-only ownership, expected-SHA lease release, full comment/label checks, and inherited review lock. Never use a comment-only fallback. Claim run id:2d5e629f-0ec5-4e40-8617-ba721909e978. An independent reviewer must assess this use. Reuse current linked worktree; no cleanup of cockpit-owned worktrees. Backport decision: release/v0.19.x has the same vulnerable adapter range/resolution; request supported backport label.

## Verification evidence

Old adapter1.19.14: new security fixture returns200 and fails (1failed/1controlpassed). Patched2.1.3: malformed path404; both cases pass. Focused static/origin coverage96/96; real-loopback JSON/cookie/SSE test1/1. Installedgraph and all lockcopies2.1.3; only adapterentry+service range differ; npm audit targetabsent (16unrelated residualpackages).

All configured commands passed in order with timeout600, CEZ_INSTANCE_ID unset and TMPDIR/TMP/TEMP=/tmp: typecheck; npmtest15374pass/8existingskips; coreunit; build/checkpack; package35pass. First typecheck exposed testmiddleware requiring async, corrected e3a1005c before finalgate. Premature package invocation before build is not the final gate. No appsource/default/settings/workflow/API/state/env changes.

Independent authoritative review: code APPROVE, zero findings on efd5fc38; all five gates independently repeated, regression red/green, installed-removal proof and live cockpit WebSocket/origin/shutdown integration pass. [Review5880049385](https://github.com/open-mercato/cezar/pull/2143#pullrequestreview-5880049385) is COMMENTED: native self-approval rejected because same bot. Eligible external native approval remains required. No source edits by reviewer. RunnerNode24; no separateNode20 execution claimed.

## Progress

PR: #2143

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Minimal upgrade and proof

- [x] 1.1 Upgrade the adapter and add malformed-path regression plus loopback integration coverage — 323fbb8e

### Phase 2: Validation

- [x] 2.1 Run all five ordered configured npm gates and targeted security verification — e3a1005c

### Phase 3: Independent review and publication

- [x] 3.1 Complete authoritative independent review and any fixes — efd5fc38
- [ ] 3.2 Finalize evidence, labels, deduplication and claim release
