# Execution plan — the cockpit's star ask

**Date:** 2026-09-30
**Slug:** `cockpit-star-ask`
**Branch:** `feat/cockpit-star-ask`
**Engine:** om-auto-create-pr (steps: 10, --loop: no)

## Goal

Ask cezar's users — once, quietly, in three places — to star the project on GitHub: a ⭐ button
with the live star count in the cockpit sidebar, a one-time toast after the user's first
successful run, and one line in the `cezar serve` terminal banner.

## Scope

A request, nothing more. Explicitly **not** a growth mechanic:

- no reward, no unlock, no counter the user has to beat;
- nothing is gated, delayed, or degraded for a user who never stars;
- the toast fires **once per browser, ever**, and never returns;
- every surface degrades to silence — offline, rate-limited, or `CEZ_NO_BANNER=1`.

### Affected areas

| Surface | Where |
| --- | --- |
| Star count service | `packages/cezar/src/server/star-count.ts` (new) |
| Contract + route | `packages/contract/src/…`, `packages/cezar/src/server/server.ts`, `BACKWARD_COMPATIBILITY.md` §2 |
| Terminal banner | `packages/cezar/src/skills-banner.ts` (or a sibling), `packages/cezar/src/index.ts` |
| Sidebar button | `packages/web/src/components/app-shell.tsx`, `app-shell-container.tsx` |
| Toast | `packages/web/src/components/ui/toaster.tsx`, `packages/web/src/lib/star-promo.ts` (new), `packages/web/src/components/star-promo.tsx` (new) |
| Docs | `.env.example`, `docs/reference.md` |

### Non-goals

- No new `CEZ_*` variable. The existing `CEZ_NO_BANNER=1` is widened to mean "no promos at all"
  and that widening is documented — a second switch for the same intent is a knob, not a feature.
- No telemetry, no "did they star it" check, no GitHub auth. cezar never learns the answer.
- No change to the star target: it is always `open-mercato/cezar`, never the user's own repo.
- No re-prompt, no nag loop, no second toast, no dismissable-and-returns banner.
- No change to run lifecycle, statuses, or the review gate.

## Design decisions

**The count is fetched server-side, not by the browser.** The cockpit has never made a
third-party request and should not start: one cezar process fetching once per 6 h is strictly
less exposure than every open tab doing it, it keeps working in remote mode where the browser
may not reach the internet, and it reuses `server/github.ts`'s house contract —
`{ available: false, reason }` for every failure, never an error.

**`CEZ_NO_BANNER=1` silences all three surfaces.** AGENTS.md § Zero config requires a network
widening to have an off switch; it also forbids trading a working default for a knob. One
existing switch covering the whole promo satisfies both: with it set the terminal line is gone,
the route answers `available: false`, and the cockpit renders neither the chip nor the toast.

**"First successful run" is a status TRANSITION into `done` or `review`**, detected off the
cached run list exactly as `run-notifications.tsx` does it — a run seen for the first time never
counts, so a cold boot with a finished run in the list stays silent.

## Implementation Plan

### Phase 1: The star count, server-side

- **1.1** `packages/cezar/src/server/star-count.ts`: fetch `api.github.com/repos/open-mercato/cezar`,
  zod-validate `stargazers_count` at the boundary, cache in memory + `~/.cache/cez/` for 6 h,
  hard timeout, never throws, `{ available: false }` under `CEZ_NO_BANNER=1` or any failure.
  Unit tests for cache hit/miss/expiry, malformed payload, network error, and the off switch.
- **1.2** Contract schema for the payload, `GET /api/v1/star-count` chained into the workspace
  family (single-mount, like `/health`), inventoried in `BACKWARD_COMPATIBILITY.md` §2.

### Phase 2: The terminal banner line

- **2.1** One line in the `cezar serve` startup banner asking for a star, behind the same
  `shouldShowSkillsBanner` gate, with tests pinning both the presence and the silenced case.

### Phase 3: The sidebar ⭐ button

- **3.1** `formatStarCount` (`842`, `1.2k`, `12.3k`) plus a `useStarCount()` query with a long
  stale time, in the cockpit's existing query layer. Unit tests on the formatter's boundaries.
- **3.2** `StarChip` in the sidebar footer's controls row, cut from `VersionChip`'s cloth: a
  link to the repo, `⭐` + count, accessible name, `rel="noreferrer"`. Absent — not empty —
  when the count is unavailable. Tests for render, absence, and the accessible name.

### Phase 4: The one-time toast

- **4.1** Give `toast()` an optional action link and an optional lifetime, so a toast can carry
  "Star on GitHub" without a second toast implementation. Tests for both, and for the default
  staying exactly what it is today.
- **4.2** `packages/web/src/lib/star-promo.ts`: the one-time flag (localStorage, a blocked or
  full store degrades to "already seen" so a failure can never produce a repeating toast), the
  verbatim message, and the first-success transition detector. Pure, table-tested.
- **4.3** `<StarPromo />`, a headless watcher mounted once in `app.tsx`, subscribing to the run
  list cache the way `RunNotifications` does. Tests: fires once, never twice, silent on cold
  boot, silent when already seen, silent when the count route says unavailable.

### Phase 5: Docs and the gate

- **5.1** `.env.example` and `docs/reference.md` — `CEZ_NO_BANNER=1` now silences the star ask too.
- **5.2** Full validation gate: `npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, `npm run test:package`.

## Risks

| Risk | Mitigation |
| --- | --- |
| A first browser→internet call from the cockpit | Avoided: the fetch is server-side, once per 6 h, cached on disk. |
| GitHub rate limiting (60/h unauthenticated per IP) | 6 h cache and a single in-flight fetch; a 403 is just `available: false`. |
| A new footer control overflows the 264 px sidebar column (#702) | The chip is ~52 px and the row is a `flex-col` of deliberate rows, not a wrap; a test pins it. |
| The toast repeating and becoming a nag | The flag is written **before** the toast is shown, and a storage failure degrades to "seen". |
| The promo reading as a paywall | Nothing is gated; the copy is the user's verbatim wording. |

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: The star count, server-side

- [ ] 1.1 Star count service with disk cache and total failure tolerance
- [ ] 1.2 Contract schema, `GET /api/v1/star-count`, BC inventory

### Phase 2: The terminal banner line

- [ ] 2.1 Star line in the `cezar serve` startup banner

### Phase 3: The sidebar ⭐ button

- [ ] 3.1 `formatStarCount` + `useStarCount()`
- [ ] 3.2 `StarChip` in the sidebar footer

### Phase 4: The one-time toast

- [ ] 4.1 Toast action link and lifetime
- [ ] 4.2 `star-promo.ts` — one-time flag, message, first-success detector
- [ ] 4.3 `<StarPromo />` watcher mounted in `app.tsx`

### Phase 5: Docs and the gate

- [ ] 5.1 `.env.example` + `docs/reference.md`
- [ ] 5.2 Full validation gate green
