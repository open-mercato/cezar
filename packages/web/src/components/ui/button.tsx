import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* Variant vocabulary comes from the mockups' `.btn-*` classes, not stock shadcn:
 * `primary` (lime) and `contrast` (inverse surface) are the two CTAs, `danger-ghost` is the
 * destructive affordance. There is deliberately no `secondary`/`link` — the design system doesn't use them.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[7px] rounded-md font-semibold whitespace-nowrap transition-[background-color,border-color,opacity,filter] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:brightness-[0.96]",
        contrast: "bg-contrast text-contrast-foreground hover:brightness-[0.96]",
        outline: "border border-border bg-card hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        "danger-ghost": "text-danger hover:bg-danger/10",
      },
      size: {
        default: "h-9 px-3.5 text-[13.5px]",
        sm: "h-[30px] rounded-sm px-2.5 text-[12.5px]",
        icon: "size-9",
        "icon-sm": "size-[30px] rounded-sm",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
