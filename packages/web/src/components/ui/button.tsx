import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* The five button variants of the UI strategy (redesign 2026-11): `primary` (violet fill, white
 * ink), `contrast` (inverse surface), `outline`, `ghost`, and `destructive` — the filled red with
 * white ink that ONLY confirms inside a dialog. `danger-ghost` is kept for the red in-row
 * affordance callers still use; prefer a labelled menu item for it. No `secondary`/`link`.
 *
 * One height per size: `default` 36px, `sm` 30px, `xs` 24px — and `xs` is for table cells only.
 * Buttons sharing a row share a size.
 */
const VARIANT_CLASSES = {
  primary: "bg-primary text-primary-foreground hover:brightness-[0.96]",
  contrast: "bg-contrast text-contrast-foreground hover:brightness-[0.96]",
  outline: "border border-border bg-card hover:bg-muted",
  ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  "danger-ghost": "text-danger hover:bg-danger/10",
  destructive: "bg-danger text-danger-foreground hover:brightness-[0.96]",
} as const

/** The variant table, for tests and pickers — the source of truth is `VARIANT_CLASSES`. */
const buttonVariantNames = Object.keys(VARIANT_CLASSES) as ReadonlyArray<keyof typeof VARIANT_CLASSES>

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[7px] rounded-md font-semibold whitespace-nowrap transition-[background-color,border-color,opacity,filter] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: VARIANT_CLASSES,
      size: {
        default: "h-9 px-3.5 text-ui",
        sm: "h-[30px] rounded-sm px-2.5 text-label",
        icon: "size-9",
        "icon-sm": "size-[30px] rounded-sm",
        xs: "h-6 gap-1 rounded-sm px-2 text-label [&_svg:not([class*='size-'])]:size-3",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
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

export { Button, buttonVariantNames, buttonVariants }
