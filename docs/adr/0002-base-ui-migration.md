# Migrate UI primitives from Radix to Base UI (Mira-leaning, incremental)

The cockpit's `web/app/src/components/ui/` primitives are moving from `radix-ui` to
`@base-ui/react` (the successor library shadcn now ships as its `base-*` component styles),
with the visual direction leaning on shadcn's **Mira** style — the compact option built for
dense, data-heavy UIs, which is what a cockpit is. The migration is deliberately incremental:
each batch swaps the primitive layer inside a `ui/` wrapper while keeping the wrapper's
exported names and prop surface Radix-compatible, so the ~20 consumer files don't churn per
batch.

## Status

- **Batch 1 (done):** tooltip, switch, collapsible, tabs, label, separator, popover,
  scroll-area. `label` and `separator` need no heavyweight primitive (native `<label>`,
  Base UI `Separator`).
- **Batch 2 (done):** dialog, alert-dialog, sheet (all on Base UI `Dialog`),
  dropdown-menu (`Menu`). The `tw-animate-css` import is gone — every migrated overlay
  transitions on `data-starting-style`/`data-ending-style`.
- **Batch 3 (pending):** command (cmdk still drags in Radix Dialog — replace with
  Base UI `Autocomplete`/`Combobox` or keep cmdk last), toaster. `select` left the batch:
  it had zero consumers and was deleted outright in the 2026 redesign (WP1).
- **Cleanup (last):** drop the `radix-ui` dependency once no wrapper references it —
  `button`/`badge` still import `Slot`, and cmdk carries its own Radix Dialog.

## Compatibility layer

- `lib/as-child.ts` — `asChildProps()` translates Radix's `asChild` composition to Base UI's
  `render` prop inside the wrappers; call sites keep writing `asChild`.
- Radix's focus-callback props are mapped, not dropped: `onOpenAutoFocus` →
  `initialFocus={false}`, `onCloseAutoFocus` → `finalFocus={false}` (every call site in this
  codebase only ever called `event.preventDefault()`).
- `PopoverAnchor` is a shim: Base UI anchors via a Positioner prop, so the wrapper captures
  the anchor element in a context and feeds it to `PopoverContent`'s Positioner.
- Radix's `onInteractOutside` has no Base UI equivalent on the popup; the composer now guards
  in `onOpenChange` via `eventDetails.reason === 'outside-press'` + `eventDetails.cancel()`.

## Consequences not obvious from the diff

- **State selectors changed shape.** Radix `data-state="open|closed|checked|active"` became
  Base UI presence attributes: `data-open`/`data-closed` (roots/panels), `data-panel-open`
  (collapsible triggers), `data-checked`/`data-unchecked` (switch), `data-active` (tabs).
  Styling and tests must target these.
- **Popper CSS vars renamed:** `--radix-popover-content-available-height` →
  `--available-height` (set on the Positioner); transform origin is `--transform-origin`.
- **Disabled triggers stay focusable.** Base UI hardcodes `focusableWhenDisabled` on
  collapsible triggers and tabs: a locked control renders `aria-disabled="true"` instead of
  the native `disabled` attribute (screen-reader users can still discover it). Tests assert
  `aria-disabled`; hover styling uses `not-aria-disabled:` instead of `enabled:`.
- **Switch opts back into a native button.** Base UI defaults to a `<span role="switch">`;
  the wrapper passes `nativeButton render={<button/>}` because forms and tests rely on native
  `disabled` semantics there.
- **Overlay animations moved off `tw-animate-css`.** Migrated popups animate with CSS
  transitions on `data-starting-style`/`data-ending-style` (Base UI holds the element in the
  DOM until the exit transition ends). With batch 2 done no overlay references the library,
  so the `@import "tw-animate-css"` line left `index.css`.
- **Menus open on mousedown and highlight via attribute.** Base UI's `Menu.Trigger` opens on
  `mousedown` (Radix used `pointerdown` — tests that open menus fire `mouseDown` now), and
  items style their active state with `data-highlighted`, not DOM-focus `focus:` variants.
- **Menu items fire `onClick`.** The dropdown-menu wrapper keeps accepting Radix's `onSelect`
  and forwards it from Base UI's click; radio/checkbox items pass `closeOnClick` so picking
  one still dismisses the menu (Base UI defaults them to staying open).
- **AlertDialog Action/Cancel are `Close` underneath.** Base UI has no Action/Cancel parts;
  both wrappers render `AlertDialog.Close` styled with the app's button vocabulary, and
  initial focus lands on the first tabbable element — the Cancel button, by DOM order.
- **Mira-leaning radius scale.** The token sheet's radius steps tightened one notch
  (sm 8→6, md 10→8, lg 12→10, xl 16→14 px) — the dense look comes from tokens, not from
  editing components; density itself stays on the existing `data-density` lever.
