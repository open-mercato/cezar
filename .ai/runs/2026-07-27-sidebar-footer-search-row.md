# Execution plan — sidebar footer: full-width search bar + a controls row

**Issue:** [#702](https://github.com/open-mercato/cezar/issues/702)
**Branch:** `fix/sidebar-footer-search-row`
**Base:** `main`
**Skill:** `om-auto-create-pr`

## 🎯 Goal

The cockpit sidebar footer currently renders as a single `flex flex-wrap` row whose children
overflow the fixed 264px column, so the theme toggle is silently pushed onto a second line and
sits there alone, left-aligned, while the settings gear is pinned right on line 1. Restructure the
footer into two *intentional* lines — a full-width search affordance on line 1, and
`Tools · v{version} · ⚙ · theme` on line 2 — so every control is deliberately placed and nothing
looks like an accidental orphan.

## Scope

- `packages/web/src/components/app-shell.tsx` — the `sidebar-footer` container, `CommandPaletteHint`.
- `packages/web/src/components/app-shell.test.tsx` — footer structure assertions.
- `packages/web/e2e/smoke.e2e.ts` — a browser assertion that the footer really occupies two rows.

Note on paths: issue #702 was written against the pre-monorepo layout (`web/app/src/...`). The
`refactor(packages)` restructure (#695, `b47d507b`) has since moved the cockpit to
`packages/web/src/...`; this run targets the current layout. Everything else in the issue's
analysis — the component names, the line-level reasoning, the width arithmetic — still holds.

## Non-goals

- Making the sidebar resizable or introducing a `--sidebar-width` CSS variable.
- Wiring real search behavior into the new bar — it stays a launcher for the existing ⌘K palette.
- Restyling the Tools menu, the version chip's update affordance (#368), or the settings page.
- Any change to the theme cycle logic (`NEXT_THEME` in `theme-toggle.tsx`, also consumed by
  `command-palette.tsx`).
- Platform-aware ⌘/Ctrl rendering in the hint — it stays the current hardcoded `⌘K`.

## Implementation Plan

### Phase 1 — restructure the footer into two intentional rows

Turn the footer container into a column of two rows, promote the ⌘K chip into a full-width search
bar, and group the remaining controls into a single aligned row.

- **1.1 — footer container.** Keep `data-slot="sidebar-footer"` (queried by `app-shell.test.tsx`,
  `tools-menu.test.tsx` and `smoke.e2e.ts`) and change its classes from
  `flex flex-wrap items-center gap-2 gap-y-1.5` to `flex flex-col gap-1.5`, dropping `flex-wrap`
  and `gap-y-1.5` so a silent wrap can never reappear.
- **1.2 — row 1, search.** Rewrite `CommandPaletteHint` from a pill into a `w-full` input-shaped
  button: left magnifier icon, muted `Search…` label, `⌘K` pushed right with `ml-auto`. Keep
  `data-slot="command-palette-hint"` and the `onClick={() => openCommandPalette()}` handler
  (`command-palette.e2e.ts` clicks that selector) and give it the accessible name `Search`.
- **1.3 — row 2, controls.** Wrap the Tools slot, `VersionChip`, `GlobalSettingsLink`
  (`className="ml-auto"`) and `ThemeToggle` in a `flex items-center gap-2` row carrying
  `data-slot="sidebar-footer-controls"`, with `shrink-0` where an item must not compress. Row 2's
  intrinsic width is ≈ 79 + 50 + 28 + 30 + 3×8 = 211px against 236px of inner width, so it fits
  with headroom in both the desktop sidebar and the mobile drawer (both `w-[264px]`).

### Phase 2 — tests

- **2.1 — unit.** Extend `app-shell.test.tsx`: assert the footer's two children are the search
  affordance and the controls row, that the theme toggle and the settings gear are siblings inside
  the controls row, and that the search bar keeps its slot, accessible name and palette handler.
  Confirm the `#368` version-chip update affordance still renders inside the narrower row 2.
- **2.2 — browser.** Add an assertion near the existing theme-toggle visibility check in
  `smoke.e2e.ts` that the footer occupies exactly two rows: the search bar's bounding-box `y` is
  above the theme toggle's, and the theme toggle and the settings gear share the same `y`.

### Phase 3 — validation, QA evidence and review

- **3.1** Run the full validation gate: `npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, `npm run test:package`.
- **3.2** Capture before/after screenshots of the footer at the 264px sidebar width in light and
  dark themes and attach them to the PR as evidence (this is a cockpit UI change → `needs-qa`).
- **3.3** Run `om-auto-review-pr {prNumber} --autofix` and land any fixes it asks for.

## Risks

- **Low.** The change is confined to cockpit markup and Tailwind classes.
  `BACKWARD_COMPATIBILITY.md` waives `web/` markup and CSS under the cockpit UI redesign waiver,
  and no state file, API shape or NDJSON event is touched.
- The real risk is selector breakage in the e2e suites: `sidebar-footer`,
  `command-palette-hint`, `theme-toggle`, `version-chip` and `tools-menu-trigger` must all keep
  their `data-slot` values. Mitigated by keeping every hook stable and only adding one new slot.
- `theme-toggle.test.tsx` locks `data-size="icon-sm"`; if the size token changes for alignment,
  that test must be updated in the same commit. The plan keeps `icon-sm`, so no change is expected.

## Progress

PR: #705

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Restructure the footer into two intentional rows

- [x] 1.1 Footer container becomes a two-row flex column — cbb0fe0d
- [x] 1.2 Promote CommandPaletteHint into a full-width search bar — cbb0fe0d
- [x] 1.3 Group Tools, version, settings and theme into one controls row — cbb0fe0d

### Phase 2: Tests

- [x] 2.1 Unit assertions for the two-row footer structure — 59994942
- [x] 2.2 Browser assertion that the footer occupies exactly two rows — 59994942

### Phase 3: Validation, QA evidence and review

- [x] 3.1 Full validation gate green — typecheck / npm test (4625) / test:unit (36) / build / test:package (9), all green at 59994942
- [x] 3.2 Before/after screenshots attached to the PR
- [x] 3.3 `om-auto-review-pr --autofix` clean — no blockers or majors; two minors and one nit auto-fixed at 118bc26d
- [x] Post-review fix: platform-aware `commandShortcutHint` behind the search bar's kbd, and the redundant `aria-label` dropped so the accessible name matches the visible label — 118bc26d
