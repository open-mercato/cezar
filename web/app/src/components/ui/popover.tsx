"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { applyRef, asChildProps } from "@/lib/as-child"
import { keyboardAwareCollisionPadding, useViewportInsets } from "@/lib/keyboard-inset"
import { cn } from "@/lib/utils"

/* Base UI has no <Popover.Anchor>; the anchor is a prop on the Positioner. The context carries
 * the element captured by our PopoverAnchor shim down to PopoverContent so the Radix-era
 * composer call site keeps working unchanged. */
const PopoverAnchorContext = React.createContext<{
  anchor: Element | null
  setAnchor: (node: Element | null) => void
} | null>(null)

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const [anchor, setAnchor] = React.useState<Element | null>(null)
  const value = React.useMemo(() => ({ anchor, setAnchor }), [anchor])
  return (
    <PopoverAnchorContext.Provider value={value}>
      <PopoverPrimitive.Root {...props} />
    </PopoverAnchorContext.Provider>
  )
}

function PopoverTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger> & {
  asChild?: boolean
}) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...props}
      {...asChildProps(asChild, children)}
    />
  )
}

function PopoverContent({
  className,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  collisionPadding,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> &
  Pick<
    React.ComponentProps<typeof PopoverPrimitive.Positioner>,
    "side" | "align" | "sideOffset" | "collisionPadding"
  > & {
    // Radix compat: their only use in this codebase is `event.preventDefault()` to keep focus
    // where it is — mapped onto Base UI's `initialFocus`/`finalFocus` set to `false`.
    onOpenAutoFocus?: (event: Event) => void
    onCloseAutoFocus?: (event: Event) => void
  }) {
  // Collision avoidance against the viewport the user can SEE: the mobile virtual keyboard
  // shrinks only the visual viewport (iOS never resizes the layout one — see keyboard-inset),
  // so without these insets a popover near the composer positions itself under the keys.
  // Insets change re-render the content, which re-runs the positioning. Desktop engines
  // report {0,0} and keep the exact previous behavior.
  const insets = useViewportInsets()
  const anchorCtx = React.useContext(PopoverAnchorContext)
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        anchor={anchorCtx?.anchor ?? undefined}
        collisionPadding={keyboardAwareCollisionPadding(insets, collisionPadding)}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          initialFocus={onOpenAutoFocus ? false : undefined}
          finalFocus={onCloseAutoFocus ? false : undefined}
          className={cn(
            "w-72 origin-(--transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  children,
}: {
  asChild?: boolean
  children: React.ReactElement
}) {
  const anchorCtx = React.useContext(PopoverAnchorContext)
  const childRef = (children.props as { ref?: React.Ref<Element> }).ref
  const composedRef = React.useCallback(
    (node: Element | null) => {
      applyRef(childRef, node)
      anchorCtx?.setAnchor(node)
    },
    [childRef, anchorCtx]
  )
  return React.cloneElement(children, { ref: composedRef } as never)
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <div
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
}
