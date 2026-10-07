# Task workspace — product and implementation specification

> Status: discovery draft; implementation is explicitly not approved by this document.
> Design reference: [`docs/mockups/task-workspace.html`](../../docs/mockups/task-workspace.html)
> Related existing surfaces: `/tasks/:id`, `/tasks/:id/changes`, `/tasks/:id/files`, `/tasks/:id/commits`.

## 1. Summary

Turn a Cezar task into a workspace with one strip of saved layouts. Each layout contains one to
three side-by-side columns showing task views such as Conversation, Changes, Commits, Files or
Browser. The user chooses views for the columns and drags dividers to resize them. A terminal can
slide up from the bottom.

The workspace is the task detail view. It is not a separate mode alongside Session, and it is not
a redesign of Cezar's shell, navigation,
visual language, or task controls. The current app shell, project navigation, task header, action
bar, typography, spacing, and component conventions remain the source of truth. The design mockup
is a layout exploration only; its invented sidebar, header, colors, typography, content and task
chrome are not implementation requirements.

The task remains isolated in its existing worktree. The workspace adds ways to inspect and operate
on that worktree; it does not change task lifecycle, agent protocol, git review gate, or merge policy.

## 2. Problem and outcome

Today, a user moves between the Session, Changes, Files and Commits task routes. A terminal is
opened outside the browser. A running app's preview is also outside the task view. Switching routes
or windows makes it harder to follow an agent while checking what it is doing.

The desired outcome is that a user can open a task, follow the agent, inspect its live changes,
run commands and check the app in the same task context, without losing the familiar Cezar UI.

### Success criteria

- A user can inspect at least two task surfaces at once and resize their split.
- The existing task title/header, actions, and review behavior remain recognizable and work. Replace the current Session/Changes/Commits/Files tab strip with the saved-layout cards; do not show both strips.
- Existing task URLs and bookmarks continue to open the corresponding task surface.
- Opening, changing or closing a panel does not stop, resume, or otherwise alter the agent run.
- A missing terminal, preview command, worktree, or browser capability degrades to a clear empty state;
  it does not break task viewing or server startup.
- Layout preferences survive navigation away from and back to the same task.

## 3. Product principles and constraints

1. **Cezar first.** Reuse current task components and UI primitives. Add the smallest visual layer
   needed to support multiple views. Do not recreate the app shell or make a parallel design system.
2. **The current task stays the task.** `/tasks/:id` remains the canonical task URL. It opens the
   workspace with Conversation selected initially. Existing `/changes`, `/files` and `/commits`
   paths remain valid and deep-linkable.
3. **One worktree.** Every panel in a workspace belongs to the same run and its worktree. Panels
   must not silently display the boot repo or a different task's state.
4. **Observe safely.** A task may be running while the user reads its transcript, diff or files.
   Workspace navigation and resizing must not send messages or mutate task state.
5. **Explicit actions.** Starting a terminal or preview process is an explicit user action unless a
   later approved spec establishes a safe, predictable auto-start rule.
6. **Human review gate remains.** No panel auto-commits, pushes, creates a PR, merges, or accepts an
   agent's result merely because it was opened.
7. **Zero-config default.** Discover what can be discovered; missing project scripts, binaries,
   permissions or worktrees produce useful empty states rather than mandatory setup.
8. **Remote/local ownership stays honest.** Files, processes and preview ports belong to the host
   running the task, not to the browser client.

## 4. Users and core journeys

### Journey A: follow an agent and inspect its changes

1. Open a running task from the task list or a saved task URL.
2. See the existing task header and the default saved layout, which contains Conversation.
3. Create or open a saved layout, then choose Conversation and Changes in its windows.
4. Drag the divider until the transcript and diff are readable.
5. Follow new transcript events and diff updates without leaving the task.
6. Send a follow-up using the existing composer; the task's existing message semantics apply.

### Journey B: inspect files and preview the result

1. Open Files in a panel and select a path using the existing file tree and preview behavior.
2. Start the project's preview explicitly, or use the detected running preview if the approved
   preview design supports safe discovery.
3. View the app in the Browser column. Browser reloads and navigation do not change the agent
   session.
4. Optionally place Browser and Changes side by side to compare the rendered app with the current diff.

### Journey C: run a command in the task worktree

1. Open the bottom Terminal drawer.
2. Confirm its working directory is the selected task worktree.
3. Run commands in a terminal session distinct from the agent's own process/session.
4. Hide or resize the terminal without killing it. A separate explicit action ends the terminal
   process.

## 5. Functional scope

### 5.1 Panels

The panel registry is:

| Panel | Source of truth | Initial scope |
|---|---|---|
| Czat (Conversation) | Existing task thread, transcript, composer, docks and review state | Available in first layout release |
| Zmiany (Changes) | Existing task Changes view and diff actions | Available in first layout release |
| Pliki (Files) | Existing task file tree and file preview | Available in first layout release |
| Commity (Commits) | Existing task commits route and commit diff | Available in first layout release |
| Browser | Embedded browser with Chrome-like URL tabs and controls; each Browser column has its own saved tabs and addresses | Later milestone |
| Terminal | Bottom drawer with multiple VS Code-like terminal tabs; each tab has its own interactive shell whose cwd is this task worktree | Later milestone |

Do not implement placeholder Browser or Terminal panels that imply they work. If these are not in a
release milestone, keep them out of the selectable panel list or show an explicitly labeled,
actionable unavailable state.

Each visible column has a panel header using current Cezar components and visual conventions. The
header identifies the view and provides relevant existing actions. The body reuses the existing
component instead of copying its UI or data fetching logic.

### 5.2 Layout model

#### Layout cards

- Show one horizontal row of saved layout cards. This replaces the current Session/Changes/Commits/Files navigation tabs and is the only layout tab row in the workspace.
- A new task starts with one active card named `Czat` and a `Nowy układ` button. Do not create
  extra layouts by default.
- Clicking `Nowy układ` opens the view picker. Selecting an enabled tile creates a new layout with
  one full-width column, gives it an automatic editable name (for example, `Układ 2`), and
  activates it. Closing the picker before choosing cancels creation.
- Available view tiles are `Czat`, `Zmiany`, `Commity`, `Pliki` and `Przeglądarka`. The first four
  are enabled in the first layout release. `Przeglądarka` remains visible but disabled until built.
  Terminal is separate in the bottom drawer.
- Layout names are unique within the task. Double-click a card to rename it. Enter or clicking
  outside saves the name. If the entered name already exists, append the next available number (for
  example, `Debug 2`).
- Close a card with its X or its context menu. Close immediately without confirmation or undo.
  Closing the active card selects the card to its right, or the previous one if there is no card on
  the right. Closing the final card shows an empty workspace with a `Nowy układ` button. That empty
  state remains until leaving the task; reopening the task creates a fresh `Czat` card.

#### Columns within a layout

- A layout contains zero to three side-by-side columns. Rows and nested splits are not supported.
  The same view may appear in more than one column.
- A new layout starts with one full-width column showing the chosen view. To add another column to an
  existing layout, click the `+` at the right edge of the view area. It opens the same view picker.
  Selecting a tile adds and activates a column at the right.
- Two columns start at half-width each; three start at one-third each. Adding or removing a column
  divides the available width equally among the remaining columns. Dragging a column header to
  reorder the columns also resets them to equal widths.
- Users can resize columns by dragging dividers. There is no maximize button; use a one-column layout
  to focus on one view. When there are already three columns, disable `+`.
- Dragging a divider changes the widths on both sides. Provide a visible hover/focus state and a
  useful hit target. Enforce usable minimum widths; dragging must not select text or scroll the page.
  Arrow keys adjust a focused divider in small steps; Shift+Arrow uses a larger step. Expose the
  divider as an accessible separator with its position.
- Drag a column by its header to change its order. Reordering equalizes all column widths.
- Each column header identifies its view and has a control to change the view and a close control.
  Changing a column's view replaces the current view. If it was Czat, discard unsent composer text
  without a warning. If it was Zmiany and it contains an unsent comment, warn before discarding it;
  show `Zamknij mimo to` to discard the comment and change view, or `Wróć` to keep the comment and remain in Zmiany. Closing the last column leaves the layout card in place with an empty area
  and the `+` control to add another view.
- Switching to a different saved layout preserves all columns and their state, including unsent Czat
  text. Do not add another view-tab row inside each column.

#### Narrow screens

- On a narrow viewport, layouts may still contain several columns, but show one column at a time.
  Compact tabs labeled with view names switch between columns. Do not squeeze them side by side on a phone.
- Keep the existing Cezar sidebar's responsive behavior unchanged.

### 5.3 Persistence and URLs

- Persist named layouts per task on the Cezar host that owns the task. Local Cezar and a VPS each keep
  their own layouts; no transfer or synchronization between hosts is required. Leaving the task
  view, navigating away, or refreshing the page does not remove layouts. Reopening the task on the
  same host restores the selected layout, all columns, their order and widths. Layouts are removed only
  when the task itself is permanently deleted. Archiving keeps layouts for later unarchive but stops task processes. If the user deleted all layouts, the
  current task view is empty with a `Nowy układ` button; reopening that task creates a fresh default
  `Czat` layout.
- Switching to another task must not carry the previous task's transient panel state into it.
- If saved state is missing or malformed, or refers to unavailable views or impossible sizes,
  recover to the one-column Conversation default without an error. An intentionally empty workspace
  stays empty while the user remains in the task view.
- Existing `/tasks/:id/changes`, `/files` and `/commits` deep links continue to work by creating a new saved one-column layout for the requested view; existing saved layouts remain unchanged. Give it the next automatic unique layout name and activate it. The URL must preserve its intent and browser Back behavior.
- Do not put high-frequency divider movement into the URL. A future shareable layout can be
  designed separately.

### 5.4 Run lifecycle interactions

- Conversation's existing read receipt, transcript hydration, queued-message editing, composer,
  paused/waiting behavior, review panel and follow-up actions must remain intact.
- Changes must continue polling/refreshing while a run is active as it does today. A hidden column
  may pause expensive rendering, but it must not silently discard diff comments or pending input.
- Files and Changes use the selected run's worktree. A missing/reclaimed worktree gets the existing
  honest 409/empty-state treatment.
- Changing views never cancels, continues, resumes, or marks the task read/unread as a side effect.
- Switching saved layouts preserves each layout’s view state, including scroll position, file selection,
  Conversation drafts and Changes comments. Replacing a view discards that view’s local state; apply
  the specific warning and draft rules in §5.2.

## 6. Terminal feature (separate milestone)

Terminal is not just a panel around `openRunInCli`; it needs an interactive PTY transport and
lifecycle. A future terminal spec must resolve:

- PTY implementation/dependency and supported OSes.
- A Cezar server restart stops all terminal sessions and child processes; the user starts them again manually after Cezar returns. Archiving a task also stops its terminal sessions and Cezar-started apps, while preserving layouts and Browser tabs. Permanently deleting a task removes its layouts and task-owned state.
- Multiple terminal tabs, shell selection, resize propagation, scrollback cap and copy/paste.
- Which process tree is killed on stop and how shutdown/reclaimed worktrees are handled.
- How the API authenticates/authorizes terminal input for local and remote modes. Follow the
  versioned API contract, route chaining, validation and remote credential boundaries in AGENTS.md.
- Whether a PTY uses an authenticated WebSocket or another transport. Do not add a new global
  WebSocket topic unless its demand lifetime and workspace-level data safety match the existing
  topic rules.
- The bottom drawer starts hidden on a fresh task visit and is shown only after an explicit user action. After unarchiving, it is hidden and has no tabs; opening it later creates a new session. A page refresh restores whether it was open or closed. Opening a hidden drawer with existing tabs reconnects them; if it has no tabs, create a fresh terminal session. Its top edge can be dragged to change drawer height; save the preferred height per task and restore it when the task is reopened. It can contain several terminal tabs, like VS Code. Add a tab with a `+` button or a keyboard shortcut. A new tab starts as `Terminal 1`, `Terminal 2`, etc.; while a command runs, show that command as the tab name, and keep that name when it finishes until another command runs. Each tab is a separate PTY session in this task's worktree. The user can open and close terminal tabs independently using an X button or tab menu. Before closing a tab with a running process, show a warning with `Zamknij mimo to` and `Anuluj`. Confirming closes the terminal session and stops its process tree; canceling leaves it running. Closing the last terminal tab hides the drawer.
- Terminal tabs belong to the task, not to a saved layout. Switching between saved layouts keeps
  the same terminal sessions available. Switching to another task hides this task’s terminal but leaves its processes running. Returning to the task keeps it hidden with the same sessions. Refreshing or reconnecting the browser preserves processes, reattaches the tabs, and restores the
  drawer’s previous open/closed state. A Cezar server restart stops terminal sessions and child processes and removes the old terminal tabs;
  the user starts commands again in fresh tabs after Cezar returns. Archiving a task stops terminal
  sessions and Cezar-started apps, removes terminal tabs, and preserves layouts (including Browser
  tabs) for unarchive. Deleting a task also removes its layouts and task-owned state.
- Terminal input executes arbitrary shell commands on the cezar host. It must be explicitly
  user-initiated and clearly identify host, project and worktree.

## 7. Browser and app preview (separate milestone)

Browser is one of the selectable workspace views. Each Browser column has its own saved browser tabs.
Tabs use the page title as their label, with the URL as the label when loading fails. They include
Back, Forward, Reload, and a `+` button. A new tab is blank and appears at the end. Typing an address
loads it in the current tab.

- While a page loads, show a blank page and a loading indicator. Save the new address after a
  successful load. On failure, keep the attempted URL visible for correction and show
  `Nie udało się otworzyć`. Do not redirect to an external browser. When reopening the task, restore
  successfully loaded addresses; a failed tab returns blank.
- Closing the selected tab activates the tab to its right, or the previous tab when there is no tab to
  its right. Closing the last tab creates a new blank tab.
- The user may type any URL, including task app addresses and external sites such as GitHub. Cezar may
  detect URLs printed in terminal output and list them above the terminal, deduplicated by address.
  Show whether each detected server is running. If an address appears again, update the existing row.
  Do not open detected addresses automatically. The user clicks `Otwórz w Przeglądarce` to open one
  in a new Browser tab.
- A page that refuses or fails to display inside Cezar stays unavailable there; never redirect it
  externally.
- Browser preview requires a process manager, per-task port allocation, and an isolation/proxy design.
  Do not expose arbitrary task processes to unrelated loopback origins or the cockpit's authenticated
  API. Treat worktree-served app content as untrusted. Remote/VPS access must route through the host
  that owns the task.
- Task-start commands are described in §6. The selected command runs only after a user action, in a
  new terminal tab; a command such as `make dev` may start several services. If command discovery has
  no results, the user can enter a command manually.
- Cezar-started app processes keep running after the agent finishes and stop when the task is
  archived, permanently deleted, or the Cezar server restarts. They must not hold a task's `maxParallel` slot
  after the agent ends.
- Design-mode element selection is outside the first Browser release.

## 8. Non-goals for the first workspace milestone

- Replacing or visually redesigning the global sidebar, project navigation, task header or task
  list.
- Building a general-purpose IDE, Monaco editor, source-control client or terminal emulator from
  scratch.
- Editing source files in the browser. Files remains read-only in the first milestone.
- Automatically staging, committing, pushing, creating PRs, merging or accepting changes.
- Agent profile/squad redesign, new backend runners, planner orchestration, or task dispatch
  changes.
- Mobile app, desktop shell, SSH runtime or multi-host scheduler.
- Automatic preview command execution or package installation.

## 9. Implementation approach

### Milestone 0 — specification and design validation

- Agree the panel behavior, task URL semantics, panel persistence scope and desktop/mobile behavior.
- Revise the mockup to use the actual current Cezar shell and task header, or replace it with a
  focused component mockup embedded in the current task screen. The current mockup must not be
  treated as approved product chrome.
- Confirm MVP boundaries before implementation.

### Milestone 1 — layout shell with existing panels

- Build an accessible layout with up to three resizable columns and state recovery/persistence.
- Embed Conversation, Changes, Commits and Files without duplicating their data/business logic.
- Preserve the existing task header/actions and canonical route behavior.
- Keep the default view visually and behaviorally equivalent to the current task session before a
  user chooses a split.
- Avoid any terminal or preview placeholder that could be mistaken for a working feature.

### Milestone 2 — interactive terminal

- Implement PTY lifecycle, validated API transport, reconnect behavior, UI and cleanup, then expose the
  bottom terminal drawer only where the task host supports it.

### Milestone 3 — task preview

- Implement explicit startup, port allocation, authenticated/proxied access, logs and cleanup. Enable
  the Browser view only when preview is supported for the task's host.

### Milestone 4 — polish based on use

- Consider design-mode annotations and further mobile refinements based on actual use rather than
  adding them to the first cut.

## 10. Acceptance criteria for Milestone 1

- With a clean browser state, opening a task preserves the current Cezar task chrome and shows
  Conversation in one full-size column.
- A user can select Changes, Commits or Files in a column, and add a second or third column. The same
  view may appear more than once in one layout.
- Users can add up to two more columns on the right and resize every divider by pointer and keyboard.
- Closing a column divides the remaining columns equally. A saved layout may intentionally have no columns.
- Switching task ids restores the correct task-specific layout and never shows data from the prior
  task in a newly selected task.
- Existing task actions, diff comments, route deep links and browser history keep their existing
  semantics. Conversation draft behavior follows the explicit rules in §5.2.
- Narrow screens remain usable by showing one active column at a time.
- Malformed persisted state and unavailable worktrees recover gracefully.
- No terminal or preview panel claims to be functional until its own milestone is implemented.

## 11. Confirmed product decisions

- **Task view:** The existing Cezar task screen remains recognizable. The task itself contains one
  saved-layout strip, a workspace with one to three side-by-side view columns, and a hidden-by-default
  terminal drawer. Build in phases: layouts with the four existing views, then terminal, then Browser.
- **Views and layouts:** Start with `Czat` and `Nowy układ`. A new layout gets an automatic editable
  name and a view picker. Existing task views `Czat`, `Zmiany`, `Commity` and `Pliki` are enabled;
  `Przeglądarka` is visible but disabled until implemented. Add a view to an existing layout with the `+` at the right edge of the view area; it opens a tile
  picker. The new column appears at the right with equal widths. Duplicate views are allowed. Layout names are unique; duplicates get a number. A column can
  be changed or closed; a layout can be closed immediately and permanently.
- **State:** Each host stores its own task layouts. Local and VPS layouts do not sync. Layouts survive
  navigation and refresh; refresh restores the same active layout, columns and widths. Deleting all
  layouts leaves an empty view for that visit; reopening the task creates a new `Czat` layout.
- **Browser:** Each Browser column owns separate URL tabs, persisted with the task. Tabs have Back,
  Forward, Reload, page-title labels, and a `+` button. New tabs start blank and go at the end; typing
  navigates the current tab. Persist only successfully loaded addresses; after reopening the task, a
  tab whose most recent attempted address failed returns as a blank tab. Detected URLs appear above Terminal, deduplicated by address and marked when their server stops. Detecting one again updates the existing entry to running. They open only after the user clicks
  `Otwórz w Przeglądarce`; they open in a new Browser tab. Any typed URL is allowed. A failed page
  shows `Nie udało się otworzyć`, keeps the URL for editing during the current visit, and never redirects externally. When the task is reopened, that tab is blank again.
- **Terminal and commands:** The drawer starts hidden, can be resized with its height saved per task, and is shared across layouts.
  Tabs are separate task-worktree shells. Name a tab for its current command while running; keep the last command name when it finishes. Hiding the drawer or switching to another task hides it but
  keeps processes running. Refreshing or reconnecting the browser reattaches tabs to running
  processes and restores whether the drawer was open. A Cezar server restart stops terminal
  sessions and child processes and removes the old terminal tabs. Unarchiving leaves the drawer hidden
  with no tabs; opening it creates a fresh session. Closing a tab stops its process tree, with a
  warning first if a process is active. The last terminal tab closing hides the drawer; reopening
  it creates a fresh session. Commands discovered from the project show their source file
  and run only after explicit selection, in a new terminal tab. Manual commands are also allowed.
  Every running command has a Stop action; Stop ends the process and closes its tab. Commands and app
  processes keep running after the agent finishes. Archiving a task stops them and removes terminal
  tabs, but preserves layouts and Browser tabs; deleting a task also removes those layouts. A Cezar server restart stops processes
  and removes old terminal tabs. After unarchive, the drawer is hidden without tabs.
- **Narrow screens:** A layout may contain several columns; show one at a time on narrow screens and switch with compact
  tabs labeled by view.

## 12. Implementation questions (not product choices)

These details can be resolved by the implementation plan without changing the agreed behavior:

- Pick a PTY library and transport that work for Cezar’s local and VPS modes.
- Define secure task-scoped authorization, process-tree cleanup, reconnection IDs and scrollback caps.
- Choose URL detection rules and supported command-discovery sources based on repositories Cezar handles.
- Design the task-owned preview proxy and port allocation so worktree apps cannot access Cezar's authenticated API or unrelated loopback services.
- Preserve Cezar’s existing API contract rules, route chaining, runtime degradation and zero-config defaults.

## 13. Research notes

- Cezar already has independent Conversation, Changes, Files and Commits route components. Repository inspection on 2026-10-07 confirmed these task views exist; the embedded multi-tab Browser and persistent interactive bottom-drawer terminal are new capabilities. Changes
  polls the task diff while the run is active; Files has a worktree tree and text/image preview.
- Cezar's current thread includes the transcript, composer, agent/skill/plan docks, review panel,
  and task actions. Embedding it is a behavior-preservation problem, not a simple visual copy.
- Current `RunHeader` owns the task identity, status, usage, workflow rail, task actions and
  Session/Changes/Commits/Files navigation. Keep it as the familiar anchor.
- The current task UI is inside the existing app shell and project sidebar. The original HTML
  mockup draws a separate fake shell for layout exploration and should not be copied literally.
- A PTY and a preview process are new host-process capabilities. They have lifecycle, security,
  remote-access and cleanup questions that are outside a frontend-only panel implementation.
