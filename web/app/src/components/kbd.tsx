import * as React from "react"

import { cn } from "@/lib/utils"

/* The flat keyboard-shortcut hint — no faux-3D bottom border, per the redesign's
 * "every pixel carries information" rule. Decorative next to a labeled control, so
 * callers typically pass `aria-hidden`.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "rounded-sm border border-border bg-card px-1 font-mono text-2xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
