# ⌘P — the task palette

Status: implemented (2026-10-17). Companion to the ⌘K command palette (`components/command-palette.tsx`); the palette itself is
`components/task-palette/task-palette.tsx`.

## Problem

⌘K finds things — projects, tasks, views, skills — but cannot act on a task. Everything a task
offers (pin, archive, mark read, stop, delete, the git step, Open in…, the workspace views and
layouts) lives in the run header behind the mouse, and only for the task on screen.

## Shape

⌘P / Ctrl+P (claimed from the browser's Print) opens a palette **scoped to one task — the subject**.

- **On a task page** the subject is that task. The list is grouped: Actions, Git, Go to view,
  Layout, Open in, Copy, then Recent tasks.
- **Off a task page** it opens in `@` mode — the task switcher.
- **Prefixes** (VS Code's grammar): `@` tasks, `>` commands only, `#` files in the subject's
  worktree. Backspace on an empty prefix returns to the default list.
- **Switcher keys**: Enter opens the task. Tab acts on it — the palette re-scopes to that task
  without navigating (a task in another project navigates there first, then re-opens).
- **⌘P while open** cycles: the first repeat jumps into `@` with the previous task selected, each
  further press moves one down. ⌘P ⌘P Enter is "back to the last task".
- **⌘K → Tab** on a task row hands that task to ⌘P.
- **PR and issue numbers** are searchable in both palettes: `1234`, `#1234`, `pr 1234` or
  `issue 56` finds every task about it (as `taskReferences` resolves them, the chips' rule), in
  every project; an exact number ranks above a longer one that starts with it.
- **Alt+Enter** on a view opens it beside the current columns (Alt+click on a card today).
- **Shortcuts** run palette commands on the task on screen, palette shut. Defaults: ⌘1–⌘9 go to the
  task's Nth numbered tab (the views, then Notes — positional `tab:N` commands; saved layouts are
  not numbered), on the workspace and on the Notes page alike, ⌘/ opens the terminal
  in a column. Any command can be (re)bound: ⇧↵ on a palette row, or Settings → Keyboard (the
  previously hidden section). Chords need ⌘/Ctrl, ⌃ or ⌥; ⌘K, ⌘P, ⌘↵ and the browser's own
  (⌘W, ⌘T, ⌘C…) are refused. In a text field only ⌘/Ctrl chords fire; in the terminal only ⌘
  on a Mac. A chord whose command is not on offer right now (a git step that is not the next
  one) is left to the browser. In a browser tab the browser may keep ⌘1–⌘9 for itself; the
  desktop app delivers them. Holding ⌘ (Ctrl elsewhere) ON ITS OWN for 350 ms swaps each tab's icon for its
  number (never for a chord such as ⌘C or the screenshot ⌘⇧4; a release the OS swallows is caught
  by the next key or pointer event without ⌘), so the strip shows which ⌘N is which; the `…` overflow menu always lists them. No bare-key shortcuts are added; rows show the existing workspace
  keys or their chord.
- **Switching by arrow** (2026-10-21, Slack's channel keys): ⌥↑/⌥↓ open the previous/next task
  in the sidebar's order (`sortRuns`, active view — Pinned, Needs you, Working, Recent), ⌥⇧↑/⌥⇧↓
  the previous/next task that needs you (`isNeedsYouStatus`). From any page of the project on
  screen; off the ring (the Tasks table, a task that no longer needs you) ↓ starts at the top and
  ↑ at the bottom; wraps at the ends. Fires in text fields (it displaces only the paragraph
  jump), not in the terminal or under a dialog. Not rebindable; the four chords are reserved.
  `lib/task-ring.ts` is the ring, `lib/use-task-switch-shortcut.ts` the listener, mounted in
  `AppShellContainer`. Telemetry: `task_switched` with `arrow`.
  **From any app**, in the desktop shell: ⌃⌥↑/⌃⌥↓ (`tauri-plugin-global-shortcut`,
  `register_task_switch_shortcuts` in `packages/desktop/src-tauri/src/lib.rs`) raise the window
  and dispatch `cezar:switch-task` with `previous`/`next`; the cockpit steps the Needs-you ring
  as for ⌥⇧. ⌃⌥ rather than ⌥, because a global registration takes the chord from every app and
  ⌥-arrows are every text field's paragraph jump. A chord another app already owns is logged and
  skipped; a cockpit older than the event ignores it.

## Design

- `components/task-palette/commands.tsx` — `buildTaskCommands`, a pure function of the run and its surroundings.
  Gating comes from `runActionFlags` and `gitActionPolicy`, the same rules the header uses, so the
  palette never offers what the header hides. Unavailable actions stay listed with their reason.
  The phone header menu renders from the same list.
- `routes/task-thread/use-run-actions.ts` — the header's mutation bundle, extracted so the palette
  drives the same mutations. Pin/archive carry the `palette` telemetry surface.
- `lib/task-workspace-bridge.ts` — the mounted task workspace publishes its view/layout/terminal
  controls; the palette reads them only when the subject is the task on screen, and falls back to
  route navigation otherwise. A file picked in `#` mode for a task not on screen is queued and
  opened by the workspace when it mounts.
- `lib/keybindings.ts` (chords, defaults, reserved set, override merging) and
  `lib/use-keybindings.ts` (storage). Overrides live in the workspace ui-state
  (`~/.cezar/ui-state.json`, `keybindings`: command id → chord, or `null` to unbind a default),
  beside Appearance — one set per person, every project and browser. Absent means the defaults.
- `lib/recent-tasks.ts` — most-recently-opened run ids, browser-local (`localStorage`), capped.
  No server state.
- Destructive actions (Stop, Delete) open the header's existing confirm dialog; Commit opens the
  commit dialog. The palette never destroys on one Enter.
- `GET /api/v1/runs/:id/tree` — `/repo/tree`'s answer for the run's working directory, for `#`.

## Telemetry

Opt-in like all of cezar's (docs/telemetry.md), through the cockpit relay, closed label sets in
`packages/contract/src/telemetry.ts`: `palette_opened`, `task_command_run` / `task_shortcut_used`
(the command — batched in the tab, one event per label with `value`), `task_switched`,
`palette_mode_used` (search shape, never text), `palette_dismissed`, `shortcut_rebound`. Pin and
archive carry `palette` or `shortcut` as their surface. Open-ended ids fold into closed labels
(`taskCommandLabel`).

## Out of scope

Copy-as-variant/re-run, discard changes, multi-chord sequences, shortcuts for ⌘K's global commands.
