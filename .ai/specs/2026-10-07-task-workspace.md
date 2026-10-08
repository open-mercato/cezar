# Task workspace — product and implementation specification

> Status: Milestones 1-3 implemented (2026-10-08). Milestone 4 is deliberately not done — it asks
> for refinements "based on actual use rather than adding them to the first cut", so it opens when
> the feature has been used.
> Implementation: `packages/web/src/routes/task-workspace/` (cockpit) and
> `packages/cezar/src/server/terminal/` (PTY sessions, address detection, command discovery). The
> four task URLs resolve to the workspace in `packages/web/src/routes.tsx`.
>
> **Corrections made during implementation are marked inline as `IMPLEMENTATION NOTE`.** Each one
> records something this document assumed that the codebase or the platform does not support, with
> the evidence. They are part of the spec now, not deviations from it.
>
> Browser-level coverage: `packages/web/e2e/task-workspace.e2e.ts` measures the rendered column
> boxes, which is the half of §10 jsdom cannot reach — it does no layout, so every
> `getBoundingClientRect()` there is zero and a split that rendered its percentages while staying
> full-bleed would pass the unit suite. The four task-route specs that navigated by the removed
> `run-tabs` strip were rewritten onto the layout cards rather than deleted.
> Design reference: [`docs/mockups/task-workspace.html`](../../docs/mockups/task-workspace.html)
> Related existing surfaces: `/tasks/:id`, `/tasks/:id/changes`, `/tasks/:id/files`, `/tasks/:id/commits`.

## 1. Summary

Turn a Cezar task into a workspace with one strip of saved layouts. Each layout contains one to
three side-by-side columns showing task views such as Conversation, Changes, Commits, Files or
Browser. The user chooses views for the columns and drags dividers to resize them. A terminal can
slide up from the bottom.

The workspace is the task detail view. It is not a separate mode alongside Session, and it is not
a redesign of Cezar's shell, navigation, visual language, or task controls. The current app shell, 
project navigation, task header, action bar, typography, spacing, and component conventions remain 
the source of truth. The design mockup is a layout exploration only; its invented sidebar, header, 
colors, typography, content and task chrome are not implementation requirements.

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
| Czat (Conversation) | Existing task thread, transcript, composer, docks and review state | Available in Milestone 1 |
| Zmiany (Changes) | Existing task Changes view and diff actions | Available in Milestone 1 |
| Pliki (Files) | Existing task file tree and file preview | Available in Milestone 1 |
| Commity (Commits) | Existing task commits route and commit diff | Available in Milestone 1 |
| Browser | Embedded browser with Chrome-like URL tabs and controls; each Browser column has its own saved tabs and addresses | Later milestone |
| Terminal | Bottom drawer with multiple VS Code-like terminal tabs; each tab has its own interactive shell whose cwd is this task worktree | Later milestone |

Do not implement placeholder Browser or Terminal panels that imply they work. If these are not in a
release milestone, keep them out of the selectable panel list or show an explicitly labeled,
actionable unavailable state.

Each visible column has a **simple panel header** with:
- View name identifier (e.g., "Zmiany")
- Close (X) button

The header uses current Cezar components and visual conventions. The body reuses the existing
component instead of copying its UI or data fetching logic.

Embedding is one prop: each of `ThreadView`, `ChangesView`, `CommitsView` and `FilesView` takes
`embedded`, which drops that component's own `RunHeader` and changes nothing else. Their data
fetching, polling, review gate, worktree 409 states and draft handling are untouched.

**Each column is its own scroll owner.** The column body carries `data-slot="main"`, the attribute
the app shell's scroller uses, because every virtualized surface in the four views resolves its
scroll container with `el.closest('[data-slot="main"]')` — the transcript
(`task-thread/thread-scroller.tsx`), the diff (`components/diff/diff-view.tsx`) and the commit
list. The nearest such ancestor winning is what lets those views scroll inside a column with no
change to their scroll machinery.

**Two header slots stay in the Czat column** rather than moving to the workspace's single run
header: the plan mirror (`planTally`) and the continuation engine pills. Both are rendered again
by the docks inside that column, and `useContinueAction().pills` is a freshly built element on
every render, so publishing it upward would re-render the workspace on every transcript frame.

To change the view in a column, use the **menu** in its header. To ADD a column, use the `+` at the
right edge of the view area (§5.2), which opens the tile picker; the column menu offers the same
list as a shortcut.

### 5.2 Layout model

#### Layout cards

- Show one horizontal row of saved layout cards. This replaces the current Session/Changes/Commits/Files navigation tabs and is the only layout tab row in the workspace.
- A new task starts with one active card named `Czat` and a `Nowy układ` button. Do not create
  extra layouts by default.
- Clicking `Nowy układ` opens the TILE picker. Selecting an enabled tile creates a new layout with
  one full-width column, gives it the next automatic name (`Układ 2`, `Układ 3`…) and activates it.
  Closing the picker before choosing cancels creation.
- Available view tiles are `Czat`, `Zmiany`, `Commity`, `Pliki` and `Przeglądarka`. The first four
  landed in Milestone 1 and `Przeglądarka` in Milestone 3, so all five are enabled. Terminal is
  separate — it is the bottom drawer, not a column.

  > **IMPLEMENTATION NOTE — the tile is never disabled, including on a hosted cockpit.** §7 says
  > "The user may type any URL, including task app addresses and external sites such as GitHub",
  > so the column is useful wherever the cockpit runs. What a hosted cockpit cannot do is show
  > THIS TASK's own app, because a loopback address there resolves on the viewer's machine —
  > `capabilities.preview` reports that, and the column refuses such an address with the reason
  > rather than the picker refusing the whole view.
- Layout names are unique within the task. **Double-click a card to rename it** (§5.2). Right-click
  opens a context menu carrying the same actions:
  - Rename: Enter edit mode, save on Enter or click outside
  - Close: Remove layout immediately without confirmation
  
  If the entered name already exists, append the next available number (e.g., `Debug 2`).
- **Layout cards overflow:** If there are >5-6 layouts, show first 5-6 cards + "Pozostali..." dropdown
  listing remaining layouts. Clicking a layout in dropdown activates it.
- **Closing the last column in a layout:** leaves the card in place with an empty area and the `+`
  control to add another view (§5.2); §10 — "A saved layout may intentionally have no columns".
  Closing the CARD is a separate act, with its own X.
- Reopening a task: If all layouts were deleted, create a fresh default `Czat` layout.

#### Columns within a layout

- A layout contains 0 to 3 side-by-side columns (zero after its last column is closed — §10). Rows and nested splits are not supported.
  The same view may appear in more than one column (duplicates allowed).
- A new layout starts with one full-width column showing the chosen view.
- To add another column, click the `+` at the **right edge of the view area**; the column menu
  offers the same picker.
  It opens the view picker. Selecting a tile adds and activates a column at the right.
- Column width distribution:
  - 2 columns: 50% each
  - 3 columns: 33.3% each
  - When removing a column: remaining columns divide available space equally
- Users can resize columns by dragging dividers:
  - **Mouse drag:** Click and drag divider left/right
  - **Keyboard:** Focus divider (Tab), then Arrow Left/Right for small steps, Shift+Arrow for larger steps
  - Dragging divider changes widths on both sides
  - Provide visible hover/focus state and useful hit target
  - Enforce usable minimum widths; dragging must not select text or trigger page scroll
  - Expose divider as accessible separator with position announcement
- Dragging a column by its header to **reorder columns:**
  - Reordering equalizes all column widths to equal distribution
  - Column can be moved left/right in the layout
- Each column header has:
  - View name identifier
  - Hamburger menu with:
    - View picker (to change view)
    - Close button (to remove column)
  - Close (X) button shortcut
- **Changing a column's view: no warning when it was Czat.** When it was Zmiany and unsent diff
  comments exist, the last Zmiany column asks first — `Zamknij mimo to` / `Wróć` (§5.2).

  > **IMPLEMENTATION NOTE.** The comments are server state (`putRunDraft`), so they are not in
  > fact destroyed; the warning is built because §5.2 asks for it, and it is the one place where
  > literal compliance costs a redundant dialog.

  > **Why neither is destroyed, and what that costs.** Composer text goes through
  > `useDraft(runId, surface)` (`routes/task-thread/thread-draft.ts`) and diff comments through
  > `useDiffComments(runId)` (`routes/task-thread/diff-comments.ts`); both are backed by the
  > server drafts surface, keyed by run. Unmounting a column discards neither, and both reappear
  > when a column shows that view again.
  >
  > So §5.2's Czat half is met by construction: nothing is discarded and nothing warns. Its Zmiany
  > half is built as written anyway — the dialog above — because it was approved, and the only
  > honest thing to say about it is that it warns about a loss that does not occur. Removing it is
  > a one-line change if that trade is not wanted.
- Switching to a different saved layout preserves all columns and their state, including unsent Czat text.

#### Narrow screens

- On a narrow viewport (mobile/tablet), layouts may still contain several columns, but show one column at a time.
- Compact **column tabs** labeled with view names switch between columns (e.g., "Czat", "Zmiany", "Pliki").
- Do not squeeze columns side by side on phones.
- Keep the existing Cezar sidebar's responsive behavior unchanged.

### 5.3 Persistence and URLs

**Storage mechanism:**
- Persist layouts **on the Cezar host that owns the task**, one file per run
  (`.ai/cezar/layouts/<runId>.json`), behind `GET/PUT /api/v1/runs/:id/layouts`
- Each host (local Cezar, VPS 1, VPS 2) keeps its own layouts independently
- No synchronization between hosts required

> **CORRECTION (2026-10-08).** An earlier revision of this section said "browser localStorage",
> which was not what §5.3 asked for and was recorded here after the fact. Browser storage cannot
> keep two of this section's own promises: "layouts are removed only when the task itself is
> permanently deleted" (clearing site data removes them sooner), and a task being the same task
> however you reach it (a second browser, profile or machine against the same cezar saw a
> different workspace). Host-side storage keeps both, and keeps the per-host separation this
> section asks for for free, since a local cezar and a VPS are different hosts holding different
> files. The browser keeps only the terminal drawer's own open/height preference, which is a
> property of the screen rather than of the task.

**State recovery:**
- Layouts survive navigation away from and back to the same task
- Page refresh restores: selected layout, all columns, column order, column widths
- If saved state is missing, malformed, or refers to unavailable views: recover to one-column Conversation default
- An intentionally empty workspace (all columns closed in a visit) stays empty until user leaves task

**Reopening a task:**
- If layout named `Czat` exists: open it
- Otherwise: open the first (oldest) layout
- If no layouts exist: create a fresh `Czat` layout

**Deep links and existing URLs:**
- Existing `/tasks/:id/changes`, `/tasks/:id/files`, `/tasks/:id/commits` continue to work
- When accessing these URLs: create a new saved one-column layout for the requested view
- Give it an automatic unique layout name (e.g., `Zmiany` if doesn't exist, else `Zmiany 2`)
- Activate the new layout; existing saved layouts remain unchanged
- The URL preserves its intent and browser Back behavior

**Do not persist:**
- High-frequency divider movements (resize operations)
- Unsaved diff comments or composer drafts (those are view-local; saved between layout switches)

### 5.4 Run lifecycle interactions

- Conversation's existing read receipt, transcript hydration, queued-message editing, composer,
  paused/waiting behavior, review panel and follow-up actions must remain intact.
- Changes must continue polling/refreshing while a run is active as it does today. A hidden column
  may pause expensive rendering, but it must not silently discard diff comments or pending input.
- Files and Changes use the selected run's worktree. A missing/reclaimed worktree gets the existing
  honest 409/empty-state treatment.
- Changing views never cancels, continues, resumes, or marks the task read/unread as a side effect.
- Switching saved layouts preserves each layout's view state, including scroll position, file selection,
  Conversation drafts and Changes comments. Replacing a view discards that view's local state; apply
  the specific warning and draft rules in §5.2.

  > **IMPLEMENTATION NOTE — how each of those actually survives.** Switching layouts UNMOUNTS the
  > columns of the layout you left, because keeping every layout's columns mounted would mean a
  > Conversation column subscribing to a transcript it is not showing. So each piece is kept by
  > something that outlives the component:
  >
  > - Conversation drafts and Changes comments: already SERVER state (`putRunDraft`, keyed by run
  >   and surface), which is also why the warning in §5.2 was removed — nothing is lost.
  > - Conversation scroll: the thread's own module-level scroll memory (`thread-scroll.ts`).
  > - File selection, in Files and Changes: `lib/view-memory.ts`, keyed per task and column, which
  >   generalises the pattern the thread and the run header were already using. Session-lifetime
  >   only — it is where you were looking, not what you chose, and a reload may start fresh.

## 6. Terminal feature (implemented, Milestone 2)

> **IMPLEMENTATION NOTE — the PTY is an optional dependency.** `@lydell/node-pty`, declared in
> `optionalDependencies`. cezar ships zero native dependencies and zero install scripts, and its
> self-update path runs `npm install` on the user's machine WITHOUT `--ignore-scripts`
> (`src/self-update/installer.ts`), so upstream `node-pty` — whose install script is
> `node scripts/prebuild.js || node-gyp rebuild` — would compile there, on whatever Node they
> have, across four platforms, and a failure would break the whole cockpit rather than one panel.
> The fork declares no install script and ships prebuilt binaries for linux/win32/darwin on
> x64+arm64. A platform with no binary reports the terminal unavailable WITH A REASON and cezar
> boots normally.
>
> **IMPLEMENTATION NOTE — `CEZ_TERMINAL` is a tri-state.** Unset it follows the deployment mode:
> on locally, off on a hosted cockpit, the same line `localHandoff` draws for every other
> host-machine affordance. `=1` opts a hosted cockpit in; `=0` turns it off everywhere. Hosted is
> opt-in because cezar has no authentication of its own, so a shell there is handed to whoever the
> reverse proxy admits — AGENTS.md's rule for a feature that widens exposure. Documented in
> `.env.example` and `docs/reference.md`.
>
> **IMPLEMENTATION NOTE — tab names come from the process table, not from what was typed.**
> `server/terminal/foreground.ts` reads a shell's live child. Typing is the wrong source: it
> misses anything a script, a key binding or a shell rewrite started, and it would have to
> re-implement line editing to know when a line was submitted. The same reading answers "is
> something running", so a tab's name and the warning for closing it cannot disagree.
>
> **IMPLEMENTATION NOTE — "Stop" interrupts; the tab's X closes.** §11 reads as though Stop should
> also close the tab. It does not: stopping a command is not the same as closing a terminal, and
> you stop a build precisely so you can read why it was wrong. Stop sends Ctrl-C; closing a tab
> with something running asks first and then takes the whole process tree.
>
> **IMPLEMENTATION NOTE — the size handshake has to be armed before the first fit.** This section
> asks for resize propagation, and the obvious shape of it is wrong in a way that is invisible
> until you look at the server: the emulator is constructed at xterm's default 80x24, and the
> OPENING fit is the one that takes it to whatever the drawer actually measures. An `onResize`
> listener attached after that fit never hears the only event that matters, and nothing fires
> again afterwards — the ResizeObserver re-fits only when the HOST changes size, and a fit that
> computes the same dimensions emits no event. The shell is then left believing it has 80 columns
> while the user looks at ~120, so zsh wraps early and anything full-screen draws wrongly. The
> listener is therefore registered BEFORE the first fit, and the fitted size is sent once
> unconditionally, which also covers the mirror case of a drawer that really does measure 80x24.
> Observed live on 2026-10-08 (a fresh session reported 113x15 instead of 80x24) and pinned in
> `terminal-pane.test.tsx`, which fails against the previous ordering.
>
> **IMPLEMENTATION NOTE — output never rides the WebSocket.** The per-session topic publishes a
> cursor and nothing else; the bytes come back over the same authenticated HTTP as the rest of the
> cockpit. The hub's topics are workspace-level and readable by anything its upgrade guard trusts,
> which is the last place terminal content belongs. Browsers also send no `Sec-Fetch-*` headers on
> a WebSocket handshake, so a connection that is not provably same-authority (a dev proxy, and
> Safari and Firefox generally) is admitted untrusted and refused the topic — the view falls back
> to polling, which costs latency and nothing else.

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
  the same terminal sessions available. Switching to another task hides this task's terminal but leaves its processes running. Returning to the task keeps it hidden with the same sessions. Refreshing or reconnecting the browser preserves processes, reattaches the tabs, and restores the
  drawer's previous open/closed state. A Cezar server restart stops terminal sessions and child processes and removes the old terminal tabs;
  the user starts commands again in fresh tabs after Cezar returns. Archiving a task stops terminal
  sessions and Cezar-started apps, removes terminal tabs, and preserves layouts (including Browser
  tabs) for unarchive. Deleting a task also removes its layouts and task-owned state.
- Terminal input executes arbitrary shell commands on the cezar host. It must be explicitly
  user-initiated and clearly identify host, project and worktree.

## 7. Browser and app preview (implemented, Milestone 3 — with one part deliberately deferred)

> **IMPLEMENTATION NOTE — tab labels come from the address, not the page title.** A cross-origin
> document's title is unreadable; that is what an iframe boundary IS. The label is derived from
> the address, which is also what this section asks for on failure — one rule, always true, rather
> than a title that is silently wrong.
>
> **IMPLEMENTATION NOTE — a framing refusal is not observable.** A page that refuses to be framed
> (`X-Frame-Options`, `frame-ancestors`) fires `load` for the refusal too, so an embedder cannot
> tell it from a success. A load timeout is the only honest signal available, and the failure
> message says only what it knows.
>
> **IMPLEMENTATION NOTE — the preview PROXY is deliberately not built, and hosted mode says so.**
> On a hosted cockpit a loopback address means the VIEWER's machine, not the host the task runs
> on, so framing it would show the wrong thing — or someone else's service. That case is refused
> with the reason rather than framed. Routing it through the owning host needs the proxy this
> section calls for, and a safe one is a larger piece of work than it looks: serving untrusted
> worktree content from the cockpit's own ORIGIN would place it beside the authenticated API,
> which is the one thing this section says not to do, and the obvious fix (an opaque-origin
> sandbox) breaks the same-origin fetches every real SPA makes. A half-safe proxy would be worse
> than an honest gap, so the gap is honest. Local cockpits — `npx cezar-cli`, the default
> deployment — need no proxy at all and work fully.
>
> **IMPLEMENTATION NOTE — detected addresses have three states, not two.** Unprobed is not the
> same claim as "nothing listening", and the strip renders them differently. Liveness is a TCP
> connect and nothing more: cezar must not send a request to a server a task started.

Browser is one of the selectable workspace views. Each Browser column has its own saved browser tabs.
Tabs use the page title as their label, with the URL as the label when loading fails. They include
Back, Forward, Reload, and a `+` button. A new tab is blank and appears at the end. Typing an address
loads it in the current tab.

- While a page loads, show a blank page and a loading indicator. Save the new address after a
  successful load. On failure, keep the attempted URL visible for correction and show
  `Nie udało się otworzyć`. Do not redirect to an external browser. When reopening the task, restore
  successfully loaded addresses; a failed tab returns blank.
- Closing the selected tab activates the tab to its right, or the previous tab when there is no tab to
  the right. Closing the last tab creates a new blank tab.
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

## 8. Non-goals for Milestone 1

- Replacing or visually redesigning the global sidebar, project navigation, task header or task
  list.
- Building a general-purpose IDE, Monaco editor, source-control client or terminal emulator from
  scratch.
- Editing source files in the browser. Files remains read-only.
- Automatically staging, committing, pushing, creating PRs, merging or accepting changes.
- Agent profile/squad redesign, new backend runners, planner orchestration, or task dispatch
  changes.
- Mobile app, desktop shell, SSH runtime or multi-host scheduler.
- Automatic preview command execution or package installation.
- Terminal or Browser features (those are separate milestones).

## 9. Implementation approach

### Milestone 1 — layout shell with existing panels (THIS MILESTONE)

- Build an accessible layout with up to three resizable columns and state recovery/persistence.
- Embed Conversation, Changes, Commits and Files without duplicating their data/business logic.
- Preserve the existing task header/actions and canonical route behavior.
- Keep the default view visually and behaviorally equivalent to the current task session before a
  user chooses a split.
- Avoid any terminal or preview placeholder that could be mistaken for a working feature.

### Milestone 2 — interactive terminal (done)

- PTY lifecycle, validated API transport, reconnect behaviour, UI and cleanup; the drawer is
  exposed only where the host supports it, and says why when it does not.

### Milestone 3 — task preview (done, except the proxy)

- Explicit startup (a discovered or typed command, run in a new terminal tab), address detection
  with liveness, and cleanup on archive/delete/restart. The Browser view is enabled everywhere and
  refuses, with the reason, the one case it cannot serve honestly: a loopback address on a hosted
  cockpit. Port allocation and a proxied preview are not built — see the note in §7.

### Milestone 4 — polish based on use (open by design)

- Consider design-mode annotations and further mobile refinements based on actual use rather than
  adding them to the first cut. Nothing here is scheduled: the milestone exists to be opened once
  the feature has been lived with.

## 10. Acceptance criteria for Milestone 1

- With a clean browser state, opening a task preserves the current Cezar task chrome and shows
  Conversation in one full-size column.
- A user can select Changes, Commits or Files in a column via its menu, and add a second or third column with the `+` at the right edge of the view area. The same view may appear more than once in one layout.
- Users can add up to two more columns on the right and resize every divider by pointer and keyboard.
- Closing a column divides the remaining columns equally. Closing the last column closes the entire layout.
- Switching task ids restores the correct task-specific layout and never shows data from the prior
  task in a newly selected task.
- Existing task actions, diff comments, route deep links and browser history keep their existing
  semantics. Conversation draft behavior follows the explicit rules in §5.2.
- Narrow screens remain usable by showing one active column at a time with column tabs.
- Malformed persisted state and unavailable worktrees recover gracefully to one-column Conversation.
- No terminal or preview panel claims to be functional until its own milestone is implemented.
- Layout state persists in localStorage and survives page refresh and navigation.
- Deep links (`/tasks/:id/changes`, etc.) create a new layout with the requested view.

## 11. Confirmed product decisions (2026-10-07)

### Storage & Persistence
- **Storage:** localStorage per task per host (local/VPS separate, no sync)
- **Recovery on malformed state:** One-column Conversation default
- **Reopening task:** Open `Czat` layout if exists, else first layout; if none, create fresh `Czat`

### Layout Cards & Management
- **New task:** Always start with single `Czat` layout
- **Adding layouts:** Click `Nowy układ` button
- **Renaming:** Right-click card → context menu → Rename
- **Overflow:** Max 5-6 visible cards, rest in "Pozostali..." dropdown
- **Closing last column:** empties the card, which keeps its place and its `+` (§5.2, §10)

### Columns & Views
- **Column count:** 1-3 per layout
- **View duplication:** Allowed (same view in multiple columns OK)
- **Column header:** Simple design with name + close button only
- **Adding column:** the `+` at the right edge of the view area → tile picker
- **Changing view:** the column menu → view list; the last Zmiany column warns when unsent diff comments exist
- **Resizing after column close:** Remaining columns divide space equally
- **Reordering columns:** Drag by header; resets all widths to equal

### Keyboard & Accessibility
- **Resize dividers:** Arrow Left/Right for small steps, Shift+Arrow for larger steps
- **Divider focus:** Tab to focus, then use arrow keys to adjust
- **Accessible announcements:** Divider position exposed as accessible separator

### Mobile & Responsive
- **Narrow screens:** One column visible at a time
- **Column switching:** Compact tabs labeled by view name
- **Sidebar:** Existing Cezar sidebar behavior unchanged

### Deep Links & URLs
- `/tasks/:id` → opens with default layout
- `/tasks/:id/changes` → creates new one-column layout named "Zmiany"
- `/tasks/:id/files` → creates new one-column layout named "Pliki"
- `/tasks/:id/commits` → creates new one-column layout named "Commity"
- Existing saved layouts not affected by deep link access

## 12. Implementation questions (not product choices)

These details can be resolved by the implementation plan without changing the agreed behavior:

- Choose localStorage key structure (e.g., `layout_state_${taskId}`)
- Define column minimum widths and divider hit target size
- Design the column menu trigger (icon style, placement)
- Implement column reorder drag UX (CSS Grid, CSS Flexbox, or absolute positioning)
- Pick localStorage max size handling (when to warn user about overflow)
- Define error handling for corrupted layout JSON

## 13. Research notes

- Cezar already has independent Conversation, Changes, Files and Commits route components. Repository inspection on 2026-10-07 confirmed these task views exist; the embedded multi-tab Browser and persistent interactive bottom-drawer terminal are new capabilities. Changes polls the task diff while the run is active; Files has a worktree tree and text/image preview.
- Cezar's current thread includes the transcript, composer, agent/skill/plan docks, review panel,
  and task actions. Embedding it is a behavior-preservation problem, not a simple visual copy.
- Current `RunHeader` owns the task identity, status, usage, workflow rail, task actions and
  Session/Changes/Commits/Files navigation. Keep it as the familiar anchor.
- The current task UI is inside the existing app shell and project sidebar. The original HTML
  mockup draws a separate fake shell for layout exploration and should not be copied literally.
- A PTY and a preview process are new host-process capabilities. They have lifecycle, security,
  remote-access and cleanup questions that are outside a frontend-only panel implementation.
