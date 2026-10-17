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
- No new bare-key shortcuts; rows show the existing workspace keys (`1`–`9`, `f`, `` ` ``, `/`).

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
- `lib/recent-tasks.ts` — most-recently-opened run ids, browser-local (`localStorage`), capped.
  No server state.
- Destructive actions (Stop, Delete) open the header's existing confirm dialog; Commit opens the
  commit dialog. The palette never destroys on one Enter.
- `GET /api/v1/runs/:id/tree` — `/repo/tree`'s answer for the run's working directory, for `#`.

## Out of scope

Copy-as-variant/re-run, discard changes, user-rebindable keys.
