import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* Variant vocabulary comes from the mockups' `.btn-*` classes, not stock shadcn:
 * `primary` (lime) and `contrast` (inverse surface) are the two CTAs, `danger-ghost` is the
 * destructive affordance. There is deliberately no `secondary`/`link` — the design system doesn't use them.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,opacity,filter] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The accent CTA — one per screen: New task, Send, Create.
        primary: "bg-primary text-primary-foreground shadow-xs hover:brightness-[0.95]",
        // The everyday solid button, and stock shadcn's `default`.
        contrast: "bg-contrast text-contrast-foreground shadow-xs hover:bg-contrast/88",
        default: "bg-contrast text-contrast-foreground shadow-xs hover:bg-contrast/88",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        outline: "border border-input bg-card shadow-2xs hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        "danger-ghost": "text-danger hover:bg-danger/10",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 text-[13.5px]",
        lg: "h-10 px-5 text-sm",
        sm: "h-8 px-2.5 text-[13px]",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-10",
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
