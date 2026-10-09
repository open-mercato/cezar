/**
 * Class resets for bespoke controls built on the shadcn primitives.
 *
 * Every control in the cockpit is a shadcn/ui component, but a good many are not *shaped* like
 * the stock one: a chip, a list row, a split pill, an icon the size of its glyph. Those pass one
 * of these resets FIRST and their own classes after it (`cn(bareButton, '…')`), so the primitive
 * contributes behavior, focus ring and `data-slot`, and the caller's classes are the whole look —
 * tailwind-merge lets the later class win.
 *
 * Colors are deliberately reset to "inherit", which is what a raw element did. A control that
 * sets its own text or background color and has NO hover variant of it must restate it under
 * `hover:` (and a Toggle's pressed look under `data-[state=on]:`), or the reset's hover wins.
 */

/** For `<Button variant="ghost">`. */
export const bareButton =
  'h-auto shrink justify-start gap-0 rounded-none p-0 text-[length:inherit] font-normal whitespace-normal text-inherit hover:bg-transparent hover:text-inherit active:translate-y-0 disabled:pointer-events-auto disabled:opacity-100'

/** For `<Toggle>`. The pressed state must be styled with `data-[state=on]:` classes. */
export const bareToggle =
  'h-auto min-w-0 justify-start gap-0 rounded-none p-0 text-[length:inherit] font-normal whitespace-normal hover:bg-transparent hover:text-inherit data-[state=on]:bg-transparent data-[state=on]:text-inherit'

/** For `<Input>` / `<Textarea>` used as a bare inline editor: no box, no ring, no dimming. */
export const bareField =
  'h-auto min-h-0 rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 disabled:pointer-events-auto disabled:opacity-100 dark:bg-transparent'
