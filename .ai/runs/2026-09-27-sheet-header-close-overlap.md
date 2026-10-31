# Sheet header text runs under the close button

## Goal

Stop a sheet's title and description from flowing underneath the sheet's close (X) button, so
long header text in the dashboard drawers (reported on "Failed outcomes") stays readable and the
X stays clickable.

## Scope

- `packages/web/src/components/ui/sheet.tsx` — the primitive that positions the close button and
  lays out the header.
- The three dashboard sheets and the subagent sheet, which each hand-rolled a partial workaround
  for the same defect (`[&>button]:min-h-11 …`, `pr-8` on the title).
- A unit test for the primitive.

### Diagnosis

`SheetPrimitive.Close` is rendered `absolute top-4 right-4` inside `SheetContent`, and
`SheetHeader` is a plain block with `p-4`. Nothing reserves the button's footprint, so header text
occupies the full width and wraps under the X. Three call sites grow the button to a 44px tap
target (`[&>button]:min-h-11 [&>button]:min-w-11`), which widens the overlap from ~8px to ~44px —
that is the screenshot the user reported.

Fixing it at each call site is what produced the existing inconsistent patches, so the fix belongs
in the primitive: make the close button one deterministic size, then reserve exactly that much
space in the header.

### Non-goals

- `dialog.tsx` — it has the same shape at a much smaller magnitude (8px), and `DialogHeader` is
  `text-center` below `sm:`, where a right-only pad would visibly decentre every dialog title. Left
  alone deliberately.
- Any change to sheet widths, content layout, or the dashboard data flow.
- A browser screenshot: no browser can be launched in this environment (`packages/web/e2e` is not
  runnable here), so verification is the unit suite plus the full gate.

## Implementation Plan

### Phase 1: Fix the primitive

- Give the close button a single deterministic 44px centred hit target in `sheet.tsx` (matching the
  WCAG 2.5.8 target the dashboards already hand-patched in), keeping its position at `top-4 right-4`.
- Reserve that footprint in the header from `SheetContent`, via a descendant rule keyed on
  `data-slot="sheet-header"`, applied only when the close button is actually rendered. It has to
  come from `SheetContent` rather than `SheetHeader`'s own base classes: three of the four headers
  pass their own `px-*`, which `cn`/tailwind-merge would drop a base `pr-*` for.
- Cover the behaviour with a unit test.

### Phase 2: Remove the now-redundant call-site workarounds

- Drop `[&>button]:min-h-11 [&>button]:min-w-11 [&>button]:grid [&>button]:place-items-center` from
  the dashboard sheets — the primitive now guarantees it.
- Drop `pr-8` from the subagent sheet's title; the header-level reserve replaces it (and `pr-8` was
  too small for the enlarged button anyway).

### Phase 3: Validation

- Run the full configured gate.

## Risks

- **Low.** The close button's icon moves ~14px in the two sheets that did not already enlarge it
  (the mobile dispatch sheet and any future sheet), because the icon now centres inside a 44px box
  instead of sitting at the corner. That is the same geometry the three dashboard sheets already
  ship, so this makes the cockpit consistent rather than introducing a new look.
- Header text wraps sooner in sheets whose title was previously full-width. Intended — that is the
  defect.
- No browser verification is possible in this environment; the change is CSS-class-level and is
  pinned by unit assertions on the emitted classes.

## Progress

PR: #1118

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Fix the primitive

- [x] 1.1 Give the sheet close button a 44px centred tap target and reserve its footprint in the header — 70f64f67
- [x] 1.2 Add `sheet.test.tsx` covering the reserve, the tap target, and `showCloseButton={false}` — 70f64f67

### Phase 2: Remove the now-redundant call-site workarounds

- [x] 2.1 Drop the `[&>button]` close-button overrides from the three dashboard sheets — 6a7e2d2e
- [x] 2.2 Drop the `pr-8` title workaround from the subagent sheet — 6a7e2d2e

### Phase 3: Validation

- [x] 3.1 Run the full validation gate — see the PR's Validation section

### Phase 4: Review

- [x] 4.1 Run `om-auto-review-pr --autofix` and land its findings — 3cc995d8 (mobile dispatch sheet: the enlarged close button covered the settings switch)
