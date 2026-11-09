import { cn } from "@/lib/utils"

/** A placeholder block shaped like the content it stands in for. Decorative: the region that
 *  holds it (`LoadingState`) carries the accessible name. The pulse is motion-safe only. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-md bg-accent motion-safe:animate-pulse", className)}
      {...props}
    />
  )
}

export { Skeleton }
