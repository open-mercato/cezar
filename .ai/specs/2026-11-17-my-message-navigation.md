# Jump between your own messages (task thread + manager chat)

Status: **design, revision 4: awaiting approval** (phase 1). Design page: [`assets/2026-11-17-my-message-navigation/design.html`](assets/2026-11-17-my-message-navigation/design.html).

## Problem

Long task transcripts and manager chats bury the user's own messages among agent output, tool
rows and cards. There is no way to step back to "what did I ask" except scrolling.

## Design

A segmented pill, `▲ · 💬 · ▼`, with **no numbers** (revision 3). In a long chat the loaded range may not hold every message, and with several of the user's messages on one screen no single index is right. The 💬 segment only opens the list. Placement, revised after the first review:

- **Everywhere (revision 4)**: the pill grows out of the existing "Jump to latest" control.
  While the reader is away from the tail (the existing `scroll.pillVisible` in the task
  thread, `scroll.away` in the manager chat), that control becomes one combined pill: `▲ · 💬
  · ▼ | ↓ Latest` on desktop, and icons only on phones (40 px, 44 px hit areas). It replaces
  `JumpToLatestPill` in `TaskDock`'s `overlay` and the round ↓ button in `manager-floating`,
  so both views match. At the tail there is nothing; returning there closes an open list.
  With no message from the user it stays today's plain "Jump to latest".
- Rejected placements: the dock's status line (revision 2: always visible, and a second
  transcript control away from "Jump to latest"); the phone composer toolbar (no one-tap
  stepping).

- **▲ / ▼** go to the previous or next message of yours, relative to the top of the viewport.
  The jump scrolls the message to 24 px below the top, focuses it (`tabIndex=-1`) and draws
  the #2218 ring (`ring-[3px] ring-ring/50`) with a 1.8 s violet wash. ▲ is disabled when
  nothing of yours lies above in any range. ▼ is disabled when everything below is already
  fully on screen.
- **List**: opened by the middle segment. Desktop: a popover (150 ms hover opens a peek, a
  click pins it). `no-hover:` devices: a bottom sheet with 44 px rows. Oldest at the top,
  newest at the bottom, sticky day headers, HH:mm, a two-line plain-text preview, and an
  attachment icon with a count. Every message of yours that is on screen gets a violet bar
  and `aria-current`. It is a `listbox` with `aria-activedescendant`: ↑/↓/Home/End move,
  Enter jumps, Esc closes and returns focus.
- Shortcuts: ⌥↑ / ⌥↓ while focus is in the transcript, never in the composer, registered in
  `keybindings.ts` so they can be rebound. At the tail ⌥↑ is the keyboard way in: it jumps to
  the last message, which brings the pill in.

Alternatives rejected: the chat header (far from the reading position, and the phone task
header is full) and scrollbar ticks (positions are unknown for unloaded ranges and virtua
only estimates sizes, they can't be tapped, and iOS hides the scrollbar).

## Data and paging

- **Task**: `useRunHistory` retains at most 5 pages, so the client cannot list every user
  message. Add `GET /api/v1/runs/:id/user-messages` (zod schema in `packages/contract`, chained
  into the runs family, aliased under `/p/:projectId`). It returns `{ seq, ts, preview,
  attachments: { images, files } }[]`, built from the NDJSON (`user-message` lines and the
  initial task), with `preview` capped at 240 chars server-side. A jump to an unloaded `seq`
  pages back through the existing #1909 refill until that `seq` is loaded, then reveals it.
- **Manager**: `?kind=user` on the messages route (same paging shape). A jump runs the
  #2218 `fetchNextPage` loop until the id is loaded.
- While a range loads, the list row shows a spinner. A failure shows a toast and leaves the
  scroll position alone.
- Streaming: a message the user sends appears at once as "Sending…" (queued task messages as
  "Queued"). It never moves the active row or focus. A jump un-pins the tail exactly as a
  scroll-up does.

## Reduced motion

No smooth scroll and no wash; the ring alone marks the target.

## Phase 2 plan (after approval)

1. Contract + routes: task `user-messages` index; manager `kind=user` filter (+ parity tests).
2. `packages/web`: one shared `MyMessagesNav` (pill + popover/sheet + listbox) fed by a
   per-view adapter (`items`, `isLoaded(id)`, `ensureLoaded(id)`, `elementFor(id)`).
   Mounted in `task-thread.tsx` and `manager-chat.tsx`.
3. Tests: unit tests (nav state math, the list's keyboard handling, hidden when there are no
   messages, the jump into an unloaded range) and an e2e test (`my-messages.e2e.ts`: arrows,
   the list, the jump that pages); before/after screenshots on desktop and phone.
