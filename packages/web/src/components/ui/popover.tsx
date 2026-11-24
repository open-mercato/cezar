"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import {
  choosePopoverPlacement,
  naturalHeight,
  safeAreaTop,
  visibleBand,
  type PopoverPlacement,
  type PopoverSide,
} from "@/lib/popover-placement"
import { cn } from "@/lib/utils"

type Padding = NonNullable<React.ComponentProps<typeof PopoverPrimitive.Content>["collisionPadding"]>

// The element the content is placed against: an explicit PopoverAnchor, else the trigger.
interface AnchorSlots {
  trigger: React.RefObject<HTMLElement | null>
  anchor: React.RefObject<HTMLElement | null>
}
const AnchorContext = React.createContext<AnchorSlots | null>(null)

function setRef<T>(ref: React.Ref<T> | undefined, value: T) {
  if (typeof ref === "function") ref(value)
  else if (ref) (ref as React.RefObject<T>).current = value
}

function useSlotRef<T extends HTMLElement>(slot: React.RefObject<HTMLElement | null> | undefined, ref: React.Ref<T> | undefined) {
  return React.useCallback(
    (node: T | null) => {
      if (slot) slot.current = node
      setRef(ref, node)
    },
    [slot, ref],
  )
}

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const trigger = React.useRef<HTMLElement | null>(null)
  const anchor = React.useRef<HTMLElement | null>(null)
  const slots = React.useMemo(() => ({ trigger, anchor }), [])
  return (
    <AnchorContext.Provider value={slots}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </AnchorContext.Provider>
  )
}

function PopoverTrigger({
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const slots = React.useContext(AnchorContext)
  const composed = useSlotRef(slots?.trigger, ref)
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" ref={composed} {...props} />
}

function paddingSides(padding: Padding | undefined): { top: number; bottom: number; left: number; right: number } {
  if (typeof padding === "number") return { top: padding, bottom: padding, left: padding, right: padding }
  return { top: padding?.top ?? 0, bottom: padding?.bottom ?? 0, left: padding?.left ?? 0, right: padding?.right ?? 0 }
}

/**
 * Picks the side and max height against the VISUAL viewport and re-picks while open as the
 * keyboard opens or closes, the anchor moves or resizes, or the content changes
 * (lib/popover-placement).
 * Floating-ui already clips to the visual viewport, so no keyboard inset goes into the padding.
 */
function usePopoverPlacement(options: {
  enabled: boolean
  content: HTMLElement | null
  slots: AnchorSlots | null
  preferred: PopoverSide
  sideOffset: number
  padding: { top: number; bottom: number }
}): { placement: PopoverPlacement | null; natural: number; safeTop: number } {
  const { enabled, content, slots, preferred, sideOffset } = options
  const { top: padTop, bottom: padBottom } = options.padding
  const [state, setState] = React.useState<{ placement: PopoverPlacement | null; natural: number; safeTop: number }>({
    placement: null,
    natural: 0,
    safeTop: 0,
  })
  React.useLayoutEffect(() => {
    if (!enabled || !content || !slots) return
    let safeTop = safeAreaTop()
    const measure = () => {
      const anchor = slots.anchor.current ?? slots.trigger.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const band = visibleBand(window, safeTop, { top: padTop, bottom: padBottom })
      const natural = naturalHeight(content)
      const placement = choosePopoverPlacement({
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        viewTop: band.top,
        viewBottom: band.bottom,
        naturalHeight: natural,
        sideOffset,
        preferred,
      })
      setState((current) =>
        current.placement?.side === placement.side &&
        current.placement.maxHeight === placement.maxHeight &&
        current.natural === natural &&
        current.safeTop === safeTop
          ? current
          : { placement, natural, safeTop },
      )
    }
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const onResize = () => {
      safeTop = safeAreaTop()
      schedule()
    }
    // A scroll inside the menu's own list moves neither the anchor nor the band.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && content.contains(event.target)) return
      schedule()
    }
    measure()
    const viewport = window.visualViewport
    viewport?.addEventListener("resize", schedule)
    viewport?.addEventListener("scroll", schedule)
    window.addEventListener("resize", onResize)
    window.addEventListener("scroll", onScroll, { capture: true, passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule)
    observer?.observe(content)
    const anchor = slots.anchor.current ?? slots.trigger.current
    if (anchor) observer?.observe(anchor)
    // An anchor that moves on its own (a banner pushes it) is caught by Radix's autoUpdate, which
    // rewrites the popper wrapper's style: re-measure on that rather than polling every frame.
    const wrapper = content.parentElement
    const moved = wrapper && typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null
    if (wrapper) moved?.observe(wrapper, { attributes: true, attributeFilter: ["style"] })
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener("resize", schedule)
      viewport?.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("scroll", onScroll, { capture: true })
      observer?.disconnect()
      moved?.disconnect()
    }
  }, [enabled, content, slots, preferred, sideOffset, padTop, padBottom])
  return enabled ? state : { placement: null, natural: 0, safeTop: state.safeTop }
}

function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  avoidCollisions = true,
  collisionPadding,
  style,
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const slots = React.useContext(AnchorContext)
  const [content, setContent] = React.useState<HTMLElement | null>(null)
  const composed = React.useCallback(
    (node: HTMLDivElement | null) => {
      setContent(node)
      setRef(ref, node)
    },
    [ref],
  )
  const padding = paddingSides(collisionPadding)
  const vertical = side === "top" || side === "bottom"
  const { placement, natural, safeTop } = usePopoverPlacement({
    enabled: avoidCollisions && vertical,
    content,
    slots,
    preferred: side === "top" ? "top" : "bottom",
    sideOffset,
    padding,
  })
  // Clamped only when the room is short; the content (or a flex-shrinking inner list) scrolls.
  const room = placement?.maxHeight ?? null
  const clamp = room !== null && room < natural ? { maxHeight: room, overflowY: "auto" as const } : null
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        ref={composed}
        align={align}
        side={placement?.side ?? side}
        sideOffset={sideOffset}
        avoidCollisions={avoidCollisions}
        collisionPadding={{ ...padding, top: padding.top + safeTop }}
        style={clamp ? { ...style, ...clamp } : style}
        className={cn(
          "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  const slots = React.useContext(AnchorContext)
  const composed = useSlotRef(slots?.anchor, ref)
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" ref={composed} {...props} />
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
