# Extension placements — panels and commands outside Settings

Status: implemented (2026-11-13). Extends
`.ai/specs/2026-11-05-extension-system-design.md`, whose panels, commands and forms render in
Settings → Extensions by default.

## Goal

An enabled extension's panels and commands appear where the user works — the command palette, the
project sidebar and the task workspace — declared in the manifest, rendered by the same
declarative renderer, with no new trust granted to the extension.

## Non-goals

- Arbitrary HTML/React from extensions (the extension-system rule stays).
- New permissions. Task-scoped reads reuse `project.read`; the only mutation stays
  `tasks.propose` (permission `task.create`).
- A separate hosted surface: everything here follows `capabilities.extensions`
  (`2026-11-12-hosted-extensions.md`).
- A marketplace, per-user placement overrides, or drag-and-drop of extension cards.

## Manifest (additive, inside API `0.1` — BACKWARD_COMPATIBILITY.md §6b)

```json
"contributes": {
  "panels":   [{ "id": "summary", "title": "Project summary", "location": "sidebar" },
               { "id": "task-notes", "title": "Notes", "location": "task" }],
  "commands": [{ "id": "refresh", "label": "Refresh summary", "location": "palette" },
               { "id": "summarize", "label": "Summarize this task", "location": "task" }]
}
```

- `location` is optional on both; it defaults to `settings`, so a manifest without it renders only in
  Settings → Extensions.
- Panel locations: `settings` | `sidebar` | `task`. Command locations: `settings` | `palette` |
  `task`.
- Limits (`packages/extension-sdk/src/schemas.ts`): at most 3 `sidebar` panels and 5 `task`
  panels per extension; 20 palette commands.
- A host with placements accepts manifests without `location`. A host without placements parses
  manifests strictly and rejects one that contains `location`, so an extension using placements
  requires a host that ships them (BACKWARD_COMPATIBILITY.md §6b).

## Context passed to the extension

- `task`-located panels and commands receive `{ runId }`, asserted by the host and never taken
  from the payload's own `projectId`. The panel provider signature is
  `(context?: { runId?: string })`; the command handler input carries `runId` for the `task`
  location.
- Context API `tasks.get(runId)` (requires `project.read`) returns the same public shape as one
  item of `tasks.list()`, or `null` when the project has no such task. Nothing else is added.
- Palette and sidebar surfaces pass no task context.

## Cockpit surfaces

1. **Command palette** — a group "Extensions" after "Actions", listing the `palette` commands of
   the current project's enabled extensions as "<Extension name>: <command label>". Selecting runs
   the command; the result (`message` or a task proposal) goes through the same proposal/toast path
   as Settings → Extensions. Hidden when `capabilities.extensions` is off. A command never appears
   while its extension's worker is `failed`.
2. **Project sidebar** — `sidebar` panels render as collapsible sections under the sidebar
   project's area list (above Current tasks; the project the switcher names, also on off-project
   pages; none in Manager mode), collapsed by default, title = panel title, body = the declarative renderer. A
   failed or stopped worker shows the section with a one-line error and a link to Settings →
   Extensions. The collapsed state is optional UI state in `~/.cezar/ui-state.json`
   (`sidebarExtensionPanels.collapsed`), never required.
3. **Task workspace** — ONE built-in view `extensions` in `workspaceViewSchema`, offered in the
   view picker only when at least one enabled extension contributes a `task` panel or command.
   Each `task` panel is a card and `task` commands are buttons in the view header. Persisted
   layouts therefore gain one closed literal, not dynamic ids. The layout loader drops unknown
   view ids from a saved layout instead of discarding the file, so a future view degrades to "that
   view is missing", not "all layouts reset".

**Compatibility with released versions:** v0.19.0 and earlier discard a run layout that fails
their schema, so a layout naming `extensions` falls back to the default layout for that task there
(written state, rebuilt; BACKWARD_COMPATIBILITY.md §3).

## Data flow and liveness

- `GET /extensions/placements?location=…` (project-scoped, chained, zod) returns
  `{ available, extensions: [{ extensionId, name, status, panels[], commands[] }] }` for one
  location. Panel bodies are fetched per panel (`/extensions/:extensionId/panels/:panelId`, with
  an optional `runId` query validated as middleware) so a slow extension never blocks the list.
- Refresh: the extension change subscription (WebSocket locally, SSE on a hosted cockpit)
  invalidates placements and panels; task-view panels also refetch, debounced, when the run's
  status or a step status changes — not on every run patch.
- Every panel/command id is qualified in the UI as `<extensionId>/<id>`, so ids never collide.

## Failure and security posture

- The renderer is unchanged: text, status, table, actions. No HTML.
- A panel error, including an over-limit (1 MiB) reply, renders inside its card with a retry; the
  host view (sidebar/task/palette) never fails because an extension did.
- `task` commands run with the host-asserted `runId`; an extension cannot act on a run of another
  project (the manager resolves `runId` through the project's own store and answers 404
  otherwise).
- When extensions are unavailable the placements route answers `{ available: false,
  extensions: [] }` (a read, not a 409) and the cockpit hides every surface.

## Acceptance

- The project-summary example (`examples/extensions/project-summary`), installed from a local
  folder, shows its panel in the sidebar, its command in the palette and its task panel and
  command in a task's `extensions` view, without a restart.
- Disabling the extension removes all three on the next change notification; a crashed worker
  shows error cards, never a blank sidebar or a broken palette.
- An extension without `location` renders only in Settings → Extensions.
- `contract-parity`, `route-parity`, `typed-bodies`, `bc-route-inventory` and web unit tests
  cover the slice in CI; the browser suite `npm run test:e2e:runner extensions` is run manually
  before a release.
