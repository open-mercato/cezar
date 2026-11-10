# Change-aware CI monitoring wakes (#2040)

Source doc: `.ai/specs/2026-07-24-monitoring-session-auto-wake.md` (extended by this run)

## Goal

A monitoring wake whose watched PR/CI state has not changed since the run parked must not spend a
full-context model turn; only a real change (or the bounded heartbeat) wakes the agent. When the
state cannot be read, behave exactly as today.

## Scope

- `packages/cezar/src/server/forge/github.ts` — `fetchPrWatchFingerprint` (one `gh pr view`).
- `packages/cezar/src/workflows/run.ts` — the wake-timer fire consults the fingerprint for a run
  with a declared PR; unchanged → a counted, turn-free check; changed/unavailable → today's wake.
- Spec, `.env.example`, `docs/reference.md`, AGENTS.md (default-on gh call, kill switch
  `CEZ_MONITORING_PR_WATCH=0`), docs feature page.

Non-goals: new protocol markers, park-mode (`null`) behaviour, the 40-check ceiling, liveness timer,
dispatch supervision, graph `github.wait-ci`.

## Design

- Watch = run has `prNumber` and an interval is configured. Baseline fingerprint is probed when the
  wake timer is armed for a park; cleared when the run leaves monitoring.
- Fingerprint: PR state, head OID, conflicting flag, review decision, each check's
  (name, status, conclusion/state), review and comment counts.
- Unchanged tick: counted toward `MAX_AUTO_CONTINUES` (keeps today's wall-clock ceiling), a note,
  re-arm. Every 6th consecutive unchanged tick wakes anyway (heartbeat for non-CI waits).
- Races: one in-flight check per watch; clearing the wake timer cancels it.

## Risks

- A PR-declared run monitoring something other than the PR now re-checks every ~30 min instead of
  5 (heartbeat). Mitigated by the review/comment counts in the fingerprint and the kill switch.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Implementation

- [ ] 1.1 Fingerprint probe in the forge seam
- [ ] 1.2 Change-aware wake in the monitoring timer
- [ ] 1.3 Regression tests (red without the change)

### Phase 2: Docs and validation

- [ ] 2.1 Spec, env contract, AGENTS.md, docs page
- [ ] 2.2 Full validation gate
