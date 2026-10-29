# Archive a task together with its finished subtasks (#1752)

## Goal

Archiving a task also archives the finished subtasks it dispatched, and restoring it brings back
exactly those subtasks — from every archive surface, in one click.

## Scope

- `RunStore`: an optional `archivedWith` field on `RunRecord` (state-format addition, optional so
  old `runs.json` files parse); a cascade that walks `dispatch.parentRunId` recursively from the
  archived run, takes descendants that are `done`/`failed`/`cancelled` with no unanswered
  question (the `archiveFinished` rule), stops below a live descendant, and stamps
  `archivedWith = <archived run id>`. Restoring a run restores every record whose `archivedWith`
  names it. A direct archive/restore of a run clears its own `archivedWith`.
- `POST /runs/:id/archive`: runs the per-run side effects (`stopTaskProcesses`,
  `notifyQuestionRetired`) for every cascaded id; `task_archived`/`task_unarchived` carry
  `value = 1 + N`. The response stays one `RunRecord` — the children ride the `run` SSE, and
  every surface already invalidates its run lists on settle.
- Contract: `archivedWith` on `runRecordSchema`.
- Cockpit: the All tasks optimistic patch moves the finished subtree with the parent, using the
  same rule, so the children do not flicker until SSE.

Non-goals: cancelling live children; changing **Archive finished**; deleting tasks; an opt-out
checkbox; an "and N subtasks" tooltip (non-blocking open question — follow-up).

Decisions on the triage comment's open points: walk `parentRunId` recursively (archiving a
mid-tree child takes its own subtree); a live descendant stops the walk below it; the parent's own
status is not checked (the rule applies to the children); no response-contract change.

## Risks

- `risk-high`: changes what the archive route does. Reversible by design — restore undoes the
  cascade exactly.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Server cascade

- [ ] 1.1 Store cascade + archivedWith field with unit tests
- [ ] 1.2 Archive route side effects per cascaded run + contract field + route test

### Phase 2: Cockpit

- [ ] 2.1 All tasks optimistic patch cascades to finished subtasks with tests
