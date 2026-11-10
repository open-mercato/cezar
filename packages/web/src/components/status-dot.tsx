import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { watchOffscreen } from "@/lib/offscreen"
import { cn } from "@/lib/utils"

/* The 7px status dot — the design system's single carrier of status color.
 * Rows, pills and nav items stay neutral; the dot is what's tinted. See the mockups' `.dot-*` classes.
 * `pulse` marks a transitioning state (running / waiting) and uses Tailwind's stock `animate-pulse`
 * rather than a bespoke keyframe, per the design system's "quiet motion" rule. An off-screen
 * pulse is paused (`lib/offscreen.ts`): dozens of them in a long chat cost idle main thread.
 */
const statusDotVariants = cva("inline-block size-[7px] shrink-0 rounded-full", {
  variants: {
    tone: {
      success: "bg-success",
      pending: "bg-pending",
      danger: "bg-danger",
      violet: "bg-violet",
      neutral: "bg-soft-foreground",
      // Orange, not amber: an idle-closed run (spec 2026-11-04-idle-closed-attention-state).
      idle: "bg-conflict",
    },
    pulse: {
      true: "animate-pulse motion-reduce:animate-none data-offscreen:[animation-play-state:paused]",
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
  ref,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusDotVariants>) {
  const own = React.useRef<HTMLSpanElement>(null)
  React.useEffect(() => {
    if (!pulse || !own.current) return
    return watchOffscreen(own.current)
  }, [pulse])
  const setRef = React.useCallback(
    (node: HTMLSpanElement | null) => {
      own.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )
  return (
    <span
      ref={setRef}
      data-slot="status-dot"
      data-tone={tone}
      className={cn(statusDotVariants({ tone, pulse, className }))}
      {...props}
    />
  )
}

export { StatusDot, statusDotVariants }
