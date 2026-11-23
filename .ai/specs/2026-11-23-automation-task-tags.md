# Task tags on automations

**Status:** implemented · **Date:** 2026-11-23 · **Amends:** `2026-11-23-task-tags.md` § 5
(#2432, implemented by #2434)

## Problem

The task-tags spec kept tags off automation definitions and left "tagging an automation's
tasks" for later. That had a side effect the spec did not foresee: a composer "Start later" is
stored as a one-shot automation, so its tags were stripped, and the run started untagged. The
spec's claim that tags reach the deferred-start path "without extra code" did not hold.

An automation is unlike a task created by hand. It launches unattended for months, while tags
in the personal registry are renamed, deleted and scoped to projects, and its definition is
exported to other machines whose registries know none of its ids.

## Decisions

1. **Stored shape.** `task.tags?: [{ id?, name }]`, at most 10 (`automationTaskTagSchema`).
   The name is always present, so the definition still means something where the id does not.
2. **Save time** (the user is present): a live, visible id stays. A gone or foreign id falls
   back to its name. A name with no tag creates a project tag, as `POST /runs` does. The stored
   value is always `{id, name}`. Editing an automation never fails because a tag was deleted
   since it was saved.
3. **Launch time** (unattended): resolve each tag by id, then by a visible tag of the same
   name. A tag found neither way is **dropped**. It is never created, so a deleted tag does
   not come back from the dead. A tag never refuses a launch. Each dropped tag leaves one
   `note` event on the run.
4. **Import and cross-project templates.** Imports keep `{id, name}`. An id unknown on the new
   machine falls back to its name at launch, and is dropped when no tag has that name.
   Templates copy names only, because the source project's ids mean nothing in another one.
5. **Composer "Start later".** The deferred-start route resolves the composer's refs while the
   user is there and stores `{id, name}` on the one-shot definition. The launch then follows
   rule 3, like any automation.
6. **Storage robustness.** A malformed `task.tags` in `automations.json` drops the tags, never
   the definition.

Tags stay a lens. Scheduling, admission, dispatch and managers never read them.

## Surfaces

- Contract: `automationTaskSchema.tags`, `automationTemplateSchema.task.tags`.
- CLI: `cez automation add … --tag <name>`, repeatable, plus the JSON `task.tags` in
  `cez automation schema`.
- Cockpit: a "Tag each run" row in the automation editor. A tag that no longer exists shows
  as a gray chip, with a line saying runs start without it. Copy as CLI emits `--tag <name>`.

## Tests

- `workspace/task-tags.test.ts`: id, then name fallback; drop without creating; a deleted tag
  stays deleted; save-time normalization.
- `automations/task-template.test.ts`: a launch applies a live tag, drops a deleted one,
  leaves a note, and recreates nothing. It fails without the launch wiring.
- `automations/store.test.ts`: a malformed stored `tags` keeps the definition.
- `server/task-tags-api.test.ts`: `POST /automations` stores `{id, name}` and creates a named tag.
- Cockpit: draft round-trip, the resolver, and Copy as CLI.
