import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { StatusDot, type StatusDotTone } from "@/components/status-dot"
import { cn } from "@/lib/utils"

/* The unified chip: one pill grammar for the whole app. `filled` is the neutral status chip
 * (color lives in the dot, never the fill), `outline` is a quiet bordered label, `interactive`
 * is the composer's trigger pill. Elements other than <span> (buttons, links) compose via
 * `chipVariants` directly.
 */
const chipVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        filled: "bg-muted text-muted-foreground",
        outline: "border border-border text-muted-foreground",
        interactive:
          "border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-55",
      },
      size: {
        sm: "h-6.5",
        md: "h-7",
        lg: "h-8 px-3",
      },
    },
    defaultVariants: {
      variant: "filled",
      size: "sm",
    },
  }
)

function Chip({
  className,
  variant,
  size,
  dot,
  pulse = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof chipVariants> & {
    /** Render a leading StatusDot in this tone. Omit for a plain chip. */
    dot?: StatusDotTone
    /** Pulse the dot to mark a transitioning state. Ignored without `dot`. */
    pulse?: boolean
  }) {
  return (
    <span
      data-slot="chip"
      className={cn(chipVariants({ variant, size }), className)}
      {...props}
    >
      {dot ? <StatusDot tone={dot} pulse={pulse} /> : null}
      {children}
    </span>
  )
}

export { Chip, chipVariants }
