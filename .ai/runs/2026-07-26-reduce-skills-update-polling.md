# Reduce skills update polling

## Goal

Prevent the skills update status query from flooding the local API while a bounded background check is still running, without changing update ownership, security boundaries, or the six-hour backend cache.

## Scope

- Adjust the cockpit query's transient retry cadence so slow checks converge with materially fewer requests.
- Add focused query-hook coverage that locks in the retry cadence and terminal-state behavior.
- Verify the affected frontend tests and the repository's configured validation gate.

## Non-goals

- Changing the updater CLI commands, lock-file provenance checks, automatic-apply preference, or backend TTL.
- Adding a new WebSocket topic for this isolated low-frequency status signal.
- Changing update-card content or visual design.

## Implementation Plan

### Phase 1: Fix and regression coverage

1. Increase the transient skills-update snapshot retry interval to a conservative cadence and document why it remains a bounded convergence poll.
2. Extend the query-hook regression test to assert the exact cadence and that terminal states stop polling.

### Phase 2: Verification and handoff

1. Run targeted tests, the configured validation gate, and the authoritative PR review; address any findings.

## Risks

- A slower retry can delay status convergence by a few seconds after a check completes; the chosen cadence must balance responsiveness with avoiding request storms.
- The backend remains authoritative and deduplicates expensive checks, so this change affects only local snapshot HTTP traffic.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

PR: #682

### Phase 1: Fix and regression coverage

- [x] 1.1 Increase the transient skills-update snapshot retry interval to a conservative cadence and document why it remains a bounded convergence poll. — da94c02a
- [x] 1.2 Extend the query-hook regression test to assert the exact cadence and that terminal states stop polling. — da94c02a

### Phase 2: Verification and handoff

- [x] 2.1 Run targeted tests, the configured validation gate, and the authoritative PR review; address any findings. — 4069bb67
