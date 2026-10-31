# Selecting a project in the sidebar, and a composition that follows the project switch

> Run plan for `om-auto-create-pr`. Two reported defects in the multi-project cockpit, both
> about the same expectation: the project you point at should become the project you are
> working in, and the thing you were writing should come with you.

## 🎯 Goal

Two user-reported defects:

1. **Clicking a project in the sidebar does not select it.** The group header is a disclosure
   control and nothing else, so opening `om-hackathon-starter` while standing in `cezar` expands
   its group but leaves the URL — and therefore the active project — on `cezar`. The sidebar
   shows no project as selected, and the **New task** CTA (a `/new` link scoped through
   `project-router`) starts a task in `cezar`, with `cezar` preselected in the composer's
   project pill.
2. **Switching project in the composer discards what you were writing.** `/p/:projectId/new`
   remounts per project (`routes.tsx` `NewTaskProjectRoute`), the draft is re-read from the
   arriving project's own storage key, and pasted attachments are not persisted at all
   (`/new` uses the composer's *uncontrolled* images state). A typed prompt plus a pasted
   screenshot are both gone the moment the project pill swaps scope.

After this change: clicking a project's name in the sidebar makes it the active project (it is
highlighted, its group opens, and every scoped affordance — New task above all — follows it),
while the chevron keeps its disclosure job so a project can still be peeked at without leaving
the page. Switching project inside the composer brings the prompt and its attachments along,
unless the project you are switching *to* already holds its own unsent draft.

## 📋 Scope

| Area | File | Change |
| --- | --- | --- |
| Sidebar | `packages/web/src/components/project-groups.tsx` | Chevron disclosure button + project-name select link; selecting expands; stronger selected affordance. |
| Sidebar tests | `packages/web/src/components/project-groups.test.tsx` | Selection, disclosure, expand-on-select. |
| Sidebar e2e | `packages/web/e2e/project-groups.e2e.ts` | Retarget the disclosure helper; cover selection. |
| Composer store | `packages/web/src/routes/new-task-draft.ts` | Per-project in-memory attachment store + the hand-off rule. |
| Composer route | `packages/web/src/routes/new-task.tsx` | Controlled `images` seam; hand off on an explicit project pick; clear on submit. |
| Composer tests | `packages/web/src/routes/new-task-draft.test.ts`, `new-task-project.test.tsx` | Hand-off semantics, per-project isolation, attachment survival. |
| Design record | `.ai/specs/2026-07-20-multi-project-workspace.md` | Amend the Sidebar and New task sections — both behaviors are the spec's, and both change. |

### Non-goals

- No persistence of `/new` attachments to `localStorage` or the server. The hand-off is
  in-memory and session-scoped; multi-MB base64 in `localStorage` is what the existing draft
  store deliberately refuses, and the run-scoped draft store (#939) belongs to a thread, not to
  a composer that has no run yet.
- The sidebar's project link does not carry a composition. It navigates to the project's tasks
  pane; issue 2 is about the composer's own project pill.
- No change to the skill/workflow/runner/model pickers on a switch — those are project-specific
  catalogs, and carrying a skill ref into a project that does not have it would be a worse bug
  than the one being fixed. Only the text and the attachments travel.
- No change to drag-to-reorder, collapse persistence storage, or the `missing`/`unregistered`
  project rows.

## 🧱 Implementation Plan

### Phase 1 — Selecting a project in the sidebar

The row today is one `<button>` that toggles collapse. It gains a second control so the two
jobs stop competing: the chevron discloses, the name selects. That keeps peeking at another
project's task list (the multi-project sidebar's whole point) while giving the row the
selection affordance it never had.

- **1.1** Split the group header: a chevron-only disclosure `<button>`
  (`data-slot="project-group-disclosure"`, carrying `aria-expanded`/`aria-controls`) beside a
  project-name `<Link to={scopeTo(project.id, '/')}>` (`data-slot="project-group-header"`,
  `aria-current="page"` when active). Siblings, never nested — a button inside a link is as
  invalid as a button inside a button, and the grip already sets that precedent in this row.
- **1.2** Selecting a project expands its group (write `collapsed[id] = false`), so a project
  cannot be selected and shut at the same time, and mark the active group clearly enough to
  read as selected rather than as hovered.
- **1.3** Unit tests in `project-groups.test.tsx`: the name link navigates into the project's
  scope; the chevron toggles collapse without navigating; selecting a collapsed group expands
  it; the collapse round-trip still costs no request.
- **1.4** Retarget the e2e `setGroupExpanded` helper at the disclosure slot and add a
  selection case; amend the spec's Sidebar section.

### Phase 2 — The composition follows the project switch

- **2.1** Add a per-project, in-memory attachment store beside the draft store in
  `new-task-draft.ts` (`readAttachments`/`writeAttachments`), keyed exactly like the draft
  (`null` = the boot project's bare key), plus `handOffComposition(from, to)` implementing the
  rule below.
- **2.2** Wire `/new` to the composer's controlled `images` seam backed by that store, and
  clear it wherever `clearStartedDraft` already runs (submit, planned start).
- **2.3** Hand the composition over on an explicit project pick in `ProjectPill`, before the
  navigate: text and attachments move to the arriving project when its draft text is empty;
  when it is not, nothing moves and both drafts stay where they are (switching back restores
  the departing one, attachments included, from the in-memory store).
- **2.4** Unit tests: `new-task-draft.test.ts` for the hand-off rule in isolation;
  `new-task-project.test.tsx` for the end-to-end swap — prompt and attachment arrive, the
  departing project is left empty, and a non-empty destination draft is never clobbered.

## ⚠️ Risks

- **A deliberate invariant changes.** `new-task-project.test.tsx`'s "keeps drafts isolated per
  project — one composer never leaks into the other" pins today's behavior, and the
  multi-project spec argues for it ("a half-typed task for the shop frontend must not surface
  in the cezar composer"). The hand-off keeps the invariant's *substance* — the composition
  exists in exactly one project at a time, because it MOVES — while answering the report. The
  test and the spec are both updated to say so, not deleted.
- **Sidebar contention.** PR #934 ("Cockpit audit remediation … projects-tree sidebar") is open
  against the same component. This run does not coordinate with it; whichever lands second
  resolves the overlap.
- **The disclosure slot renames**, and `packages/web/e2e/project-groups.e2e.ts` addresses it by
  slot. The e2e suite is not part of the configured validation gate, so it is updated by hand
  and its coverage is stated as not-run rather than implied.
- **In-memory only.** A full page reload still drops `/new` attachments (it always did). The
  hand-off fixes the project switch, which is a client-side navigation; it does not promise
  refresh-resilience the draft store never had for images.

## Progress

PR: #1018

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Selecting a project in the sidebar

- [x] 1.1 Split the group header into a chevron disclosure and a project-name select link — 750a869d
- [x] 1.2 Selecting a project expands its group and reads as selected — 750a869d
- [x] 1.3 Unit tests for selection, disclosure and expand-on-select — 750a869d
- [x] 1.4 Retarget the e2e disclosure helper and amend the sidebar spec — f4a68db1
- [x] Post-review fix: select drops the stored collapse answer instead of pinning the group open (ten selected projects would otherwise mean ten expanded groups and ten runs requests) — ba9cf530
- [x] Post-review fix: the project-name link is `aria-current="true"`, not `"page"` — it names the selected project, not the current page — ba9cf530

### Phase 2: The composition follows the project switch

- [x] 2.1 Per-project in-memory attachment store and the hand-off rule — 56ef4631
- [x] 2.2 Wire `/new` to the controlled images seam and clear it on submit — 56ef4631
- [x] 2.3 Hand the composition over on an explicit project pick — 56ef4631
- [x] 2.4 Unit tests for the hand-off rule and the end-to-end swap — 56ef4631
