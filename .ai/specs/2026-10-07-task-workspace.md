# Task workspace — layouts and terminal (extract for main)

> Status: ported to main on 2026-10-13 from `origin/brutus`, where the full specification lives.
> Kept here, under their original numbers so code citations resolve: §3 (principles), §5 (panels,
> layouts, persistence, lifecycle) and §6 (terminal). §7 (Browser preview) and §§8-13 stay on
> brutus; when the rest lands, brutus's full document replaces this file.
>
> Implementation on main: `packages/web/src/routes/task-workspace/` (layout engine, columns, strip,
> drawer), `packages/cezar/src/runs/layouts.ts` + `GET/PUT /api/v1/runs/:id/layouts` (persistence),
> `packages/cezar/src/server/terminal/` + `/runs/:id/terminal` (PTY sessions).
>
> **Where main deviates from the text below:**
> - **Terminal is also a view.** Besides the bottom drawer (§6), `terminal` is a column view: it
>   can be a card of its own (`/tasks/:id/terminal`), sit beside Chat or Changes in a split, be
>   maximized, and is saved with the layout like any other column. It is not pre-seeded in the
>   default layouts; its card is minted on first use. While the active layout shows a Terminal
>   column, the drawer is hidden (one view of the same shells, not two fighting over the PTY size).
> - **The Browser view is labelled Preview** and carries Design Mode (spec `2026-10-09-design-mode`).
>   It is a fixed card on the strip (`/tasks/:id/preview`); a born card saved as `Browser` still
>   counts as it. A terminal's detected address opens in a Preview column (§7).
> - **Main's run header.** The layout strip fills the header's tab row (`RunHeader` `tabs` slot);
>   there is no separate overview header mode. Notes keeps its own page, linked from the strip.
>   `/tasks/:id/commits/:sha` stays a standalone page; inside a column, Commits picks in place.
> - **`CEZ_TERMINAL`** unset follows `localHandoff` (on locally, off hosted) — main has no sign-in.
>   New shells do not receive brutus's per-task slot environment (`taskSlotEnv`).

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
| Graf (Graph) | The task's live workflow graph — the same component `/tasks/:id/graph` used to render as a page of its own | Added 2026-10-08 |
| Terminal | Bottom drawer with multiple VS Code-like terminal tabs; each tab has its own interactive shell whose cwd is this task worktree | Later milestone |

Do not implement placeholder Browser or Terminal panels that imply they work. If these are not in a
release milestone, keep them out of the selectable panel list or show an explicitly labeled,
actionable unavailable state.

Each visible column has a panel header using current Cezar components and visual conventions. The
header identifies the view and provides relevant existing actions.

> **OPEN DEVIATION — the header carries no view-specific actions.** As built it holds the view
> name, a menu (change view / add column / close) and an X. The approved §5.1 asks for "relevant
> existing actions" too, and that is NOT implemented.
>
> It is left open rather than guessed at because the same paragraph's next sentence pulls the
> other way: "The body reuses the existing component instead of copying its UI or data fetching
> logic." Each view's real actions — the diff's mode and wrap toggles, Changes' Push / Create PR /
> Commit toolbar, the file tree's controls — are rendered by those components, inside the column.
> Lifting them into the header means either re-implementing each toolbar there (the thing the
> sentence forbids) or hoisting state out of four components that own it. Which of the two §5.1
> intends is a product call, so it is recorded here instead of being decided quietly.

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
- Available view tiles are `Czat`, `Zmiany`, `Commity`, `Pliki`, `Przeglądarka` and `Graf`. The
  first four landed in Milestone 1, `Przeglądarka` in Milestone 3 and `Graf` on 2026-10-08, so all
  six are enabled. Terminal is separate — it is the bottom drawer, not a column.

  > **AMENDMENT (2026-10-08) — the workflow graph is a view, not a page.** The graph arrived with
  > the workflow-editor work as a sixth ROUTE tab, which the workspace had already replaced with
  > its layout cards. The two surfaces were therefore disjoint: from a workspace nothing could
  > reach the graph, and `/tasks/:id/graph` painted the legacy tab strip with no layout cards, so
  > the only way in was to type the URL. Making it a view closes that: `GraphView` takes the same
  > `embedded` prop the other four do, `/tasks/:id/graph` opens a `Graf` card like every other
  > task URL (§5.3), and a layout can hold the graph beside the conversation it describes. The
  > component is lazily imported, so a workspace with no Graf column still pays nothing for
  > `@xyflow/react`.
  >
  > The tile is offered on every task, like `Przeglądarka` and for the same reason: a task with
  > no stored workflow definition gets the view's own "No workflow graph" empty state, which is
  > honest, rather than a tile that silently is not there.

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
  control to add another view. A saved layout may therefore intentionally have no columns.
  Closing the CARD is a separate act, with its own X.

  > **CORRECTION (2026-10-08).** This bullet used to cite §10 for the sentence "A saved layout
  > may intentionally have no columns". §10 never contained it — the quote was invented, and had
  > been copied into three code comments by the time an audit caught it. The rule itself is real
  > and was confirmed on 2026-10-07 (§11, "Closing last column: empties the card, which keeps its
  > place and its `+`"), so it is stated here outright instead of being attributed. §10's own
  > bullet, which said the opposite, is corrected there.
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
- Existing `/tasks/:id/changes`, `/tasks/:id/files`, `/tasks/:id/commits` continue to work, and
  `/tasks/:id/graph` joined them on 2026-10-08
- When accessing these URLs: create a new saved one-column layout for the requested view
- Give it an automatic unique layout name (e.g., `Zmiany` if doesn't exist, else `Zmiany 2`)
- Activate the new layout; existing saved layouts remain unchanged
- The URL preserves its intent and browser Back behavior

**Do not persist:**
- High-frequency divider movements (resize operations)
- Unsaved diff comments or composer drafts (those are view-local; saved between layout switches)

> **OPEN DEVIATION — selecting a commit in a column does not move browser history.** The
> standalone `/tasks/:id/commits/:sha` URL still opens that commit, and Back/Forward between two
> such URLs works. But INSIDE a column the rows select in place rather than navigating, so Back
> does not return from a commit diff to the list the way it did on the old route.
>
> The trade is forced: §5.4 asks each layout's view state to come back when you switch to it, and
> a single URL cannot hold a different selected commit for two Commits columns. History fidelity
> for the in-column case would need per-column state in the URL, which §5.3 rules out ("Do not put
> high-frequency divider movement into the URL. A future shareable layout can be designed
> separately"). Recorded rather than resolved.

> **Implementation notes (pre-deploy review, 2026-10-12).** A failed read of the saved layouts is
> never followed by a write: the workspace opens on a stand-in that is not persisted and retries
> the read, so an error is a third state beside `null` and `[]`. The client enforces the contract's
> bounds where state grows, so a save is never rejected into a silent loss; a rejected save shows
> at once. Two tabs or devices on one task are last-writer-wins on the whole document — recorded,
> not resolved. "Open in Browser" from a fixed card opens the `<View> + Browser` pair layout
> instead of adding a column to the fixed card.

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

  > **IMPLEMENTATION NOTE (2026-10-08) — shell selection is an ALLOWLIST, discovered.** The `+`
  > asks which shell when the host offers more than one, and the list comes from the host:
  > `/etc/shells` narrowed to entries that exist, with `$SHELL` and the platform default folded
  > in (Windows has no such file, so there it is the known interpreters that are present). A
  > request may only name something already on that list; anything else is refused rather than
  > spawned.
  >
  > It is tempting to argue the allowlist adds nothing, since a terminal already runs arbitrary
  > commands inside a shell. It does: the executable a request SPAWNS is the one thing the
  > worktree discipline never covers, so taking it from the body verbatim would turn
  > `POST /terminal` into "run this binary on the host", reachable by anything the reverse proxy
  > admits — and §6 already records that a hosted cockpit has no authentication of its own.
  >
  > A host that can enumerate nothing still opens its default, and a cockpit talking to an older
  > server that sends no list simply does not offer the choice.
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

