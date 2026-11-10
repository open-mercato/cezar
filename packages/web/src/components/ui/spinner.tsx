import { LoaderCircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/** A small inline spinner for an action in flight. With a `label` it is its own `status`;
 *  without one it is decorative and the control around it says what is happening. Under
 *  `prefers-reduced-motion` it stands still. */
function Spinner({ className, label, ...props }: React.ComponentProps<"svg"> & { label?: string }) {
  return (
    <LoaderCircleIcon
      data-slot="spinner"
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
      className={cn("size-4 shrink-0 text-muted-foreground motion-safe:animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
