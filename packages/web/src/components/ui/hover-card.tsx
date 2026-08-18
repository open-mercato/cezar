"use client"

import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * The tooltip's interactive sibling: opens on hover or focus like a tooltip, but the pointer can
 * travel INTO it, so it may hold a button.
 *
 * That is the whole reason it exists here. A Radix tooltip closes the moment the pointer leaves
 * its trigger and takes any control inside it with it, and a popover only opens on click — which
 * a chip that is already a link cannot spend. A hover card is the one primitive that keeps the
 * trigger's own click and still lets a panel be used.
 *
 * Styled as the popover, not as the tooltip: the moment a panel has something to press, it is a
 * surface rather than a label, and it needs the border, the padding and the shadow that say so.
 */
function HoverCard({
  openDelay = 150,
  closeDelay = 120,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  )
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
