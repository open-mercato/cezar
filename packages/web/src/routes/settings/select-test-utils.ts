import { fireEvent, screen, within } from '@testing-library/react'

/**
 * Test-only: driving a shadcn (Radix) Select the way the tests used to drive a native `<select>`.
 *
 * Every settings select is a `SettingsSelect` now. Its trigger is a `role="combobox"` button that
 * carries the control's `aria-label`/`data-slot` and mirrors the current value in `data-value`
 * (`''` for the "auto"/"inherit" option) — so reading a value is `selectValue(trigger)`.
 *
 * Changing one means opening the listbox and picking an option by its visible label. jsdom has
 * no `PointerEvent`, so the pointer path Radix listens for never fires; the keyboard path is the
 * same code and does. The listbox is portalled to `document.body`.
 */

/** The value the trigger currently shows, as the section's own state holds it. */
export function selectValue(trigger: Element | null): string | null {
  return trigger?.getAttribute('data-value') ?? null
}

/** Opens the select and returns its options' visible labels, then closes it again. */
export function selectOptions(trigger: Element): string[] {
  const listbox = openSelect(trigger)
  const labels = within(listbox)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '')
  fireEvent.keyDown(listbox, { key: 'Escape' })
  return labels
}

/** Opens the select and picks the option with this visible label (exact string, or a pattern). */
export function pickOption(trigger: Element, name: string | RegExp): void {
  const listbox = openSelect(trigger)
  fireEvent.click(within(listbox).getByRole('option', { name }))
}

function openSelect(trigger: Element): HTMLElement {
  // Radix scrolls the selected item into view on open; jsdom does not implement it.
  if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => {}
  ;(trigger as HTMLElement).focus()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return screen.getByRole('listbox')
}
