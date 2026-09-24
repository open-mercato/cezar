import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* The 7px status dot — the design system's single carrier of status color.
 * Rows, pills and nav items stay neutral; the dot is what's tinted. See the mockups' `.dot-*` classes.
 * `pulse` marks a transitioning state (running / waiting) and uses Tailwind's stock `animate-pulse`
 * rather than a bespoke keyframe, per the design system's "quiet motion" rule.
 */
const statusDotVariants = cva("inline-block size-[7px] shrink-0 rounded-full", {
  variants: {
    tone: {
      success: "bg-success",
      pending: "bg-pending",
      danger: "bg-danger",
      violet: "bg-violet",
      neutral: "bg-soft-foreground",
    },
    pulse: {
      true: "animate-pulse",
      false: "",
    },
  },
  defaultVariants: {
    tone: "neutral",
    pulse: false,
  },
})

export type StatusDotTone = NonNullable<
  VariantProps<typeof statusDotVariants>["tone"]
>

function StatusDot({
  className,
  tone = "neutral",
  pulse = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>) {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone}
      className={cn(statusDotVariants({ tone, pulse, className }))}
      {...props}
    />
  )
}

export { StatusDot, statusDotVariants }
