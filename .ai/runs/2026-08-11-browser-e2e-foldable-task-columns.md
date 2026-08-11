# Browser-level e2e spec for the foldable Tasks-table columns

**Issue:** #822 — Add a browser-level e2e spec for foldable Tasks-table columns
**Origin:** #743 (`feat(ui): add foldable task table columns`), merged 2026-08-10
**Engine:** om-auto-create-pr (steps: 7, --loop: no)

## Goal

Close the browser-level coverage gap #743 left behind: the fold flow is exercised only in jsdom,
so nothing proves that a folded column is actually *narrower* in a real layout engine, that the
choice survives a reload, or that writing it preserves unrelated `ui-state.json` siblings.

## Scope

In scope — scenario points 1–5 and 7 from the issue:

- default fold state at a desktop viewport (Branch folded, every other foldable column expanded,
  no toggle inside the non-foldable Status and Task headers),
- folding Workflow: `data-folded`, `aria-pressed`, and a **measured** width shrink,
- persistence across a reload, verified against `$CEZ_HOME/ui-state.json`,
- sibling preservation — an unrelated `appearance.accent` written first must survive a column toggle,
- the sub-`md` card list rendering the same fields regardless of the desktop fold choices.

**Non-goals:**

- **Scenario point 6** (a queued run present while CPU and Mem are folded, asserting the two stay
  narrow) is deliberately excluded. It pins the defect in #821, which is being fixed in parallel on
  PR #861, so the assertion belongs with that fix rather than racing it here. Acceptance on #822 is
  therefore partial on that one point, and it is called out on the PR.
- No production code changes. This run adds a spec; if it found a product bug it would be filed,
  not fixed here.
- No new runner and no new CI wiring — the spec must be picked up by the existing
  `npm run test:e2e` glob.

## Approach

The spec boots **its own** cezar over a throwaway `dataRoot` with a pinned fixture `runs.json`,
following `quick-list.e2e.ts`, rather than attaching to the shared test env. Two reasons, both
load-bearing:

1. The run store reads `.ai/cezar/runs.json` **once, at startup** (`RunStore.open`), so a task rich
   enough to render every column — branch, diff stat, reference, directional usage, cost — can only
   be seeded *before* boot.
2. Points 4 and 5 read and mutate `ui-state.json`. `fixtureServeEnv()` pins `CEZ_HOME` inside the
   throwaway `dataRoot`, which is a stronger form of the issue's "isolated `CEZ_HOME`" than the
   shared `.ai/qa/cez-home` — this spec cannot collide with `settings-appearance.e2e.ts`, which
   save/restores that same file, and cleans itself up with the `dataRoot` it already removes.

`.ai/scripts/e2e.sh` still boots the shared env for the suite; this spec simply owns its own data,
exactly as `quick-list.e2e.ts` and `queued-stack.e2e.ts` already do.

## Risks

- **Measured width is the whole point and the most fragile assertion.** Under `table-layout: auto`
  the `colgroup` width is a hint, so the spec compares `getBoundingClientRect().width` before and
  after the fold and asserts a real shrink, with a margin rather than an exact pixel count.
- **The write behind a toggle is fire-and-forget.** Assertions poll the API / the file until the
  write lands, per `waitForServerAppearance` in `settings-appearance.e2e.ts`, instead of assuming
  the click beat the assertion.
- **Capability-gated columns.** Tokens and Cost only render when the health response allows them,
  so the default-state assertion enumerates the foldable headers actually present rather than
  hard-coding all nine.
- The agent-browser provider may be unprovisionable on a given machine; `e2e.sh` then reports
  `TEST_E2E_STATUS=skipped`, which this run reports as *not verified* rather than as a pass.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fixture and harness

- [x] 1.1 Add the spec file with its fixture-server boot: throwaway `dataRoot`, pinned `runs.json`
      seeded with a task carrying a branch, a diff stat, a reference and usage numbers, isolated
      `CEZ_HOME`, desktop viewport, and teardown that removes everything it created. — 8e6e0677

### Phase 2: Assertions

- [x] 2.1 Default fold state and header affordances (issue point 2). — 8e6e0677
- [x] 2.2 Folding Workflow: attribute, `aria-pressed`, and measured width shrink (issue point 3). — 8e6e0677
- [x] 2.3 Persistence across a reload, verified in `ui-state.json` (issue point 4). — 8e6e0677
- [x] 2.4 Sibling preservation against an unrelated `appearance.accent` (issue point 5). — 41170543
- [x] 2.5 The sub-`md` card list is unaffected by the desktop fold choices (issue point 7). — 41170543

### Phase 3: Verification

- [ ] 3.1 Run `npm run test:e2e` and the full configured validation gate; report honestly when the
      browser provider cannot be provisioned.
