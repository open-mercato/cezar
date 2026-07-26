import * as React from "react"

import { type StatusDotTone } from "@/components/status-dot"
import { Chip } from "@/components/ui/chip"

/* The neutral status chip from the mockups' `.pill` class — now a thin alias over the unified
 * `Chip` (filled variant). The chip itself stays `bg-muted`/`text-muted-foreground` in every
 * state — pass `dot` to express status, because in this design system the color lives in the
 * dot, not in the fill.
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
    <Chip
      variant="filled"
      dot={dot}
      pulse={pulse}
      className={className}
      {...props}
      data-slot="pill"
    >
      {children}
    </Chip>
  )
}

export { Pill }
