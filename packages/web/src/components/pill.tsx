import * as React from "react"

import { StatusDot, type StatusDotTone } from "@/components/status-dot"
import { cn } from "@/lib/utils"

/* Family: STATUS — an inline chip (h-5, rounded-full, text-ui) carrying `StatusDot` + a word.
 * The chip itself stays `bg-muted`/`text-muted-foreground` in every state — pass `dot` to express
 * status, because in this design system the color lives in the dot, not in the fill, and the tone
 * comes from the attention model (`lib/attention.ts`), never picked here. Siblings: `Chip`
 * (a changeable/static fact in the 28px row), `BranchChip` (a mono code token), `Badge` (a count).
 */
function Pill({
  className,
  dot,
  pulse = false,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  /** Render a leading StatusDot in this tone. Omit for a plain chip. */
  dot?: StatusDotTone
  /** Pulse the dot to mark a transitioning state. Ignored without `dot`. */
  pulse?: boolean
}) {
  return (
    <span
      data-slot="pill"
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full bg-muted px-2 text-ui font-medium whitespace-nowrap text-muted-foreground",
        className
      )}
      {...props}
    >
      {dot ? <StatusDot tone={dot} pulse={pulse} /> : null}
      {children}
    </span>
  )
}

export { Pill }
