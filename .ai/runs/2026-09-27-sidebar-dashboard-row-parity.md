# Sidebar: Dashboard row parity with All tasks

## Goal

Make the sidebar's **Dashboard** row read as a peer of **All tasks** — the same row height and the
same violet accent icon — instead of the slightly taller, grey-iconed row it is today.

## Context

`packages/web/src/components/app-shell.tsx` paints the two top-level sidebar doors with two
unrelated class strings:

| | Dashboard (line 565, inline `NavLink`) | All tasks (`AllTasksLink`) |
|---|---|---|
| height | `min-h-11` (44px at every breakpoint) | `h-11 md:h-9` (44px touch, 36px desktop) |
| gap / padding | `gap-2 px-3` | `gap-2.5 px-2.5` |
| type | `text-sm` | `text-[13.5px]` |
| icon | `size-4` — inherits the row's foreground (grey) | `size-4 text-violet` / `text-violet/70` |

So on desktop Dashboard is 8px taller than the row directly beneath it and its icon is the only
one of the pair without the violet accent. The Dashboard row was added as a single dense inline
line, which is how it drifted from the neighbour it sits against.

## Scope

- `packages/web/src/components/app-shell.tsx` — lift the row styling into one shared constant used
  by both doors, extract the Dashboard link into a named component next to `AllTasksLink`.
- `packages/web/src/components/app-shell.test.tsx` — pin the parity so the two rows cannot drift
  apart again.

## Non-goals

- The per-project nav rows (`h-11 md:h-[34px]`, muted foreground) stay exactly as they are — they
  are a different tier, not peers of these two doors.
- No change to routing, active-state matching, the `aria-current` contract, or the wrapper bands
  (`border-b`, paddings) around either row.
- No change to any other sidebar surface (quick list, project groups, footer).

## Implementation Plan

### Phase 1: Align the two top-level sidebar rows

- **1.1** Introduce a shared `SIDEBAR_SECTION_LINK_CLASS` + section icon class in
  `app-shell.tsx`, extract the inline Dashboard `NavLink` into a `DashboardLink` component
  (with a `data-slot="dashboard-link"` hook), and have both `DashboardLink` and `AllTasksLink`
  consume the shared classes — giving Dashboard `h-11 md:h-9` and the violet icon.
- **1.2** Add app-shell tests: the two rows carry identical height/typography classes, and the
  Dashboard icon carries the violet accent. Keep the existing Dashboard active-navigation tests
  green.

### Phase 2: Validation

- **2.1** Run the full `validation.commands` gate (`npm run typecheck`, `npm test`,
  `npm run test:unit`, `npm run build`, `npm run test:package`).

## Risks

- **Low.** Presentation-only change to two sidebar rows. The one behavioural surface touched is
  the Dashboard link's markup; its `aria-current`/active-highlight contract is already covered by
  the existing `Dashboard active navigation` tests, which must stay green.
- Making the Dashboard icon violet means the sidebar has two accent icons rather than one. That is
  the explicit ask (the two rows are peers), and the code comment in `AllTasksLink` claiming the
  violet icon is "the one spot of accent" is updated to match.

## Progress

PR: #1116

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Align the two top-level sidebar rows

- [x] 1.1 Share the section-link styling and give Dashboard the All-tasks height and violet icon — 8fe67c71
- [x] 1.2 Pin the row parity in app-shell tests — 8fe67c71

### Phase 2: Validation

- [x] 2.1 Run the full validation gate — 718bca6e
