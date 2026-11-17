# Jump between your own messages (task thread + manager chat)

Status: **design, revision 3: awaiting approval** (phase 1). Design page: [`assets/2026-11-17-my-message-navigation/design.html`](assets/2026-11-17-my-message-navigation/design.html).

## Problem

Long task transcripts and manager chats bury the user's own messages among agent output, tool
rows and cards. There is no way to step back to "what did I ask" except scrolling.

## Design

A segmented pill, `▲ · 💬 · ▼`, with **no numbers** (revision 3). In a long chat the loaded range may not hold every message, and with several of the user's messages on one screen no single index is right. The 💬 segment only opens the list. Placement, revised after the first review:

- **Desktop / tablet**: flat, 28 px, at the right end of the dock's status line, directly
  above the composer. In a task that is the hint row (`HINT_ROW`: "The agent is paused… · End
  session", budget hint), in a manager chat the quick-prompt chips row (`manager-chips`, the
  chips scroll and the pill stays pinned). With nothing else on the line, the line holds only
  the pill. It lives in the dock, so it never covers the transcript; "Jump to latest" and the
  manager's ↓ button keep floating as today.
- **Phone (`no-hover:` and below md), option M2**: no permanent control. While the reader is
  away from the tail (the existing `pillVisible` / `scroll.away` signal), the floating
  "Latest" button becomes one combined pill, `▲ · 💬 · ▼ | ↓`, 40 px tall with 44 px hit
  areas. At the tail it is gone. Rejected for phones: M1 (the desktop status-line chip,
  which costs a permanent 32 px line when no hint is showing) and M3 (a composer-toolbar
  button that opens the sheet, with no one-tap stepping, and the task toolbar is full).

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
- **Hidden** when the chat has no message from the user. If the pill was the only thing on
  the status line, the line goes too.
- Shortcuts: ⌥↑ / ⌥↓ while focus is in the transcript, never in the composer, registered in
  `keybindings.ts` so they can be rebound.

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
