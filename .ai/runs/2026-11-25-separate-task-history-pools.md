# Separate task history pools for regular and automation tasks

## Goal

Automation-launched tasks must stop evicting the tasks a person started by hand: the run index
keeps two settled-run pools (regular, automation), each sized from Settings.

## Scope

- `packages/cezar/src/runs/retention.ts` (new): resolved limits — Settings value, else
  `CEZ_RUNS_KEEP` / new `CEZ_AUTOMATION_RUNS_KEEP`, else 300.
- `packages/cezar/src/runs/store.ts` `pruneOldRuns`: non-archived runs split into two pools by
  provenance (own `automation`/`automationTrigger`/`automationTracker`, or the dispatch root's);
  archived pool unchanged.
- Workspace config `resources.runsKept` / `resources.automationRunsKept` (optional, 1–100000),
  contract response + PUT input, server GET/PUT, semaphore loader pushes them live.
- Settings → Resources → new "Task history" card with two steppers.
- `.env.example`, `docs/reference.md`.

## Non-goals

- Per-project overrides. A separate archived pool per origin. Changing the cockpit's
  Regular/Automations filter.

## Risks

- Default total kept grows from 300 to up to 600 (300 + 300) — more index/NDJSON on disk.
- Salvaged records (unreadable by this version) have no provenance and count as regular.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server

- [ ] 1.1 Retention module and split pruning in the run store
- [ ] 1.2 Workspace config keys, contract and API wiring

### Phase 2: Cockpit and docs

- [ ] 2.1 Settings → Resources task history card
- [ ] 2.2 Env contract and reference docs
