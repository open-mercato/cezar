import * as React from 'react'

import { ReferenceChip } from '@/components/reference-chip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** How long the `+N` list survives the pointer leaving it. The trigger and the list are separate
 *  elements with a gap between them, so closing instantly would make the list unreachable. */
const HOVER_CLOSE_DELAY_MS = 220

/** What a `ReferenceChip` can paint — a `TaskReference`, or a PR known only by its URL. */
type OverflowReference = { kind: 'PR' | 'Issue'; number?: number; url?: string }

/**
 * The `+N`, opened.
 *
 * A tooltip listing the hidden references told you they existed and then refused to let you go
 * to them — which is worse than not mentioning them. This is a popover of real links instead.
 *
 * It opens on HOVER where hovering exists and on click everywhere — including touch, which has no
 * hover, and the keyboard, where the trigger is a real button. Radix's HoverCard would have given
 * the first for free but not the other two: it is explicitly not a touch affordance. So this is a
 * Popover (click-and-keyboard by construction) with hover layered on, which is the combination
 * that leaves no input method without a way in.
 *
 * It lists EVERY reference, not only the hidden ones: at the moment you open it you are asking
 * "what does this task point at?", and answering with the leftovers would make you reassemble
 * the set from two places. The rows are `ReferenceChip`s, so the http-only guard, the accessible
 * names and the `target`/`rel` handling are the same ones every other reference link uses rather
 * than a second, subtly different implementation.
 */
export function ReferenceOverflow({
  references,
  taskTitle,
  hidden,
  projectId,
}: {
  references: readonly OverflowReference[]
  taskTitle: string
  hidden: number
  /** The references' own project — named by a surface standing outside it (All tasks spans the
   *  registry). Omitted, the chips answer from the surrounding `ReferenceStatusProvider`. */
  projectId?: string
}) {
  const [open, setOpen] = React.useState(false)
  // How it was opened decides whether focus moves into the list. A CLICK should hand the keyboard
  // the links; a hover must not yank focus out of whatever the reader was doing.
  const openedByHover = React.useRef(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(closeTimer.current), [])

  // Touch has no hover: a tap fires `pointerenter` first, so without this guard the list would
  // open under the finger and then be toggled shut again by the click that follows. Excluded
  // rather than allow-listing `mouse`, so a pen (which does hover) and any device that reports
  // nothing still get the hover behaviour.
  const isHover = (event: React.PointerEvent) => event.pointerType !== 'touch'
  const cancelClose = () => clearTimeout(closeTimer.current)
  const onPointerEnter = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    openedByHover.current = true
    setOpen(true)
  }
  // On a DELAY, and the same handler on the trigger and the content: the two are separate
  // elements with a 4px gap between them, so an instant close would make the list impossible to
  // reach with the pointer.
  const onPointerLeave = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="reference-overflow"
          aria-label={`Show all ${references.length} references for ${taskTitle}`}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          // A real press — mouse, tap or keyboard — is not a hover, whatever happened before it.
          onPointerDown={() => {
            openedByHover.current = false
          }}
          onClick={() => {
            openedByHover.current = false
          }}
          className="shrink-0 rounded-full px-1 text-[11px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          +{hidden}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-40 p-1.5"
        data-slot="reference-overflow-list"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onOpenAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
      >
        <p className="px-1 pb-1.5 text-[10.5px] text-soft-foreground">References</p>
        <span className="flex flex-col items-start gap-1">
          {references.map((reference) => (
            <ReferenceChip
              key={`${reference.kind}#${reference.number ?? ''}#${reference.url ?? ''}`}
              reference={reference}
              taskTitle={taskTitle}
              projectId={projectId}
            />
          ))}
        </span>
      </PopoverContent>
    </Popover>
  )
}
