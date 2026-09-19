# Autopilot — Self-Heal Loop + Control Tower

> Slug: `autopilot` · Status: implemented · Default on; `CEZ_AUTOPILOT=0` turns it off → `capabilities.autopilot`

## TLDR

Two additive surfaces that keep a swarm of coding agents under control while letting cezar
**heal its own repo** without auto-merging:

1. **Control Tower** (`/p/<project>/tower`) — workspace-wide live heatmap of running/queued
   tasks (CPU/RSS/cost/age), governor caps (`~/.cezar/autopilot.json`), what-if forecast, and
   Apply to pause offenders via the same session-close path as the memory limit.
2. **Self-Heal Loop** — built-in skill `cezar-self-heal`, heal-cycle ledger under
   `.ai/cezar/heal/<id>/cycle.json`, REST family `/heal*`, and an Automations template that
   schedules a daily cycle. Engine-run `successCriteria` is truth; draft PR only.

## Why

Running dozens of agents without a spend/RSS/stuck governor burns money and machines. Variants
already compare diffs; Self-Heal closes the loop (scout → spawn → verify → review → draft PR)
while Control Tower makes the swarm visible and killable. DNA preserved: local, plain files,
no accounts, human owns merge.

## Resolved assumptions

| # | Question | Default | Why |
|---|---|---|---|
| A1 | Capability default | ON; `CEZ_AUTOPILOT=0` off | Caps default to null (no enforcement); same shape as dispatch |
| A2 | Governor storage | `~/.cezar/autopilot.json` | Additive; deletable without touching workspace config |
| A3 | Pause mechanism | `RunManager.pauseForGovernor` | Same as memory-limit pause; Continue resumes |
| A4 | Soft maxParallel | Advisory in snapshot only for v1 | Avoid persisting a silent override of Settings → Resources |
| A5 | Heal ledger | Per-project `.ai/cezar/heal/` | Repo-local; survives restarts |
| A6 | Merge | Never | Draft PR + review gate |

## Contract

- `capabilities.autopilot` in `/health`
- `GET/PUT /api/v1/workspace/autopilot/governor`
- `GET/POST /api/v1/workspace/autopilot/tower` (`apply`, `extraParallel`)
- `GET/POST/PATCH/DELETE /api/v1/p/:projectId/heal[/:id]`

## Not done (deliberately)

- Soft-cap that mutates `resources.maxParallel` on disk
- Automatic evaluate tick on every `onUsage` sample (operator Apply / Preview for now)
- Full Mission graph UI beyond dispatch nesting + heal ledger
