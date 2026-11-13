# Execution plan — Auto-merge rollout: human vs agent triage and implementation plans

Source doc: "Cezar: reguły automatycznego merge'owania PR-ów agentowych" (2026-10-27, Patryk Lewczuk), attached to task b9d047ac.

## Goal

Split every action item of the auto-merge rules doc into what only a human (maintainer / org admin) can do and what an agent can deliver as a PR, and write one launchable implementation plan per agent workstream.

## Scope

- `.ai/analysis/2026-10-29-auto-merge-rollout/README.md` — verified current state, the triage table, ordering and dependencies.
- `.ai/analysis/2026-10-29-auto-merge-rollout/plans.md` — one plan per agent workstream (Goal, Scope, Phases/Steps, acceptance, launch brief).

Non-goals: implementing any workstream; changing CI, rulesets, labels or repo settings; editing `SDLC.md`/`CODE_REVIEW.md`/`SECURITY.md` (each is its own planned workstream). The plans live under `.ai/analysis/`, not `.ai/runs/`, so they never collide with a future run's claim check.

## Implementation Plan

Phase 1 — verify the doc's claims against the repo and the live GitHub settings, then write the triage.
Phase 2 — write the per-workstream implementation plans.

## Risks

- Low: docs only. The GitHub settings snapshot (ruleset, auto-merge flag) is dated 2026-10-29 and can drift.

## Progress

PR: #1747

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Triage

- [x] 1.1 Verify current state and write the human/agent triage — 8588c2f2b

### Phase 2: Plans

- [x] 2.1 Write per-workstream implementation plans — 7696b5f03
