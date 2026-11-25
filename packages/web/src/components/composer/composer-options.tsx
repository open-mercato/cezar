import { ChevronDownIcon } from 'lucide-react'
import { Fragment, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * One labelled row of the Options panel (design Proposal 5): a quiet label on the left, the
 * EXISTING picker for that setting on the right. The rows only move triggers — the menus the
 * footer pills used to open are the menus these cells open, so behaviour and validation never
 * fork between "the pill" and "the option".
 */
export interface ComposerOptionRow {
  id: string
  label: string
  control: ReactNode
  /** Spans the whole grid — a note, or a control too wide for half of it. */
  wide?: boolean
}

/** A choice that differs from the default, shown beside the closed trigger (`summary`). */
export interface ComposerOptionSummary {
  id: string
  label: string
}

/** The panel never grows past this; narrower composers get their own width. */
export const COMPOSER_OPTIONS_MAX_WIDTH = 760

/**
 * The composer's "Options ⌄" button and its popover: labelled rows in a two-column grid on a
 * desktop, one column on a phone. A popover rather than a dialog — nothing here blocks the
 * prompt, and dismissing it never discards a choice (every row writes straight to the host).
 *
 * It drops BELOW the trigger, as wide as the composer (capped), so it never covers the text the
 * user is writing. Radix still flips it above when there is no room underneath — the thread's
 * dock sits on the viewport's bottom edge — which is the one case the textarea is covered.
 */
export function ComposerOptions({
  eyebrow,
  rows,
  note,
  onReset,
  open,
  onOpenChange,
  onOpenAutoFocus,
  boundsRef,
  disabled = false,
  summary = [],
}: {
  /** "Options · remembered for cezar" — what the remembered values are keyed by. */
  eyebrow?: ReactNode
  rows: readonly ComposerOptionRow[]
  /** A full-width note under the grid (the interactive-skill recommendation). */
  note?: ReactNode
  /** Put every remembered row back to its default. Absent: no reset affordance. */
  onReset?: () => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Radix's open auto-focus: a host opening the panel FOR a nested menu prevents it, so the
   *  panel's own focus move does not read as leaving that menu and dismiss it. */
  onOpenAutoFocus?: (event: Event) => void
  /** The composer box: the panel is as wide as it (up to `COMPOSER_OPTIONS_MAX_WIDTH`). */
  boundsRef?: RefObject<HTMLElement | null>
  disabled?: boolean
  /** The non-default choices: the trigger gets a marker and each shows beside it, a click away
   *  from its row. Defaults stay hidden. */
  summary?: readonly ComposerOptionSummary[]
}) {
  const [innerOpen, setInnerOpen] = useState(false)
  const isOpen = open ?? innerOpen
  const width = useBoundsWidth(boundsRef, isOpen)
  if (rows.length === 0) return null
  const setOpen = (next: boolean) => {
    setInnerOpen(next)
    onOpenChange?.(next)
  }
  const modified = summary.length > 0
  return (
    <>
      <Popover open={isOpen} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-slot="composer-options-trigger"
            data-modified={modified ? '' : undefined}
            aria-label="Options"
            aria-description={modified ? 'Some options differ from the defaults' : undefined}
            disabled={disabled}
            className="h-8 shrink-0 gap-1 px-2 text-xs font-medium text-muted-foreground pointer-coarse:max-md:h-11"
          >
            Options
            {modified ? (
              <span data-slot="composer-options-marker" aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-violet" />
            ) : null}
            <ChevronDownIcon aria-hidden="true" className="size-3 text-soft-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-slot="composer-options"
          aria-label="Options"
          onOpenAutoFocus={onOpenAutoFocus}
          style={width ? { width: Math.min(width, COMPOSER_OPTIONS_MAX_WIDTH) } : undefined}
          className="@container w-[760px] max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto overscroll-contain p-3 md:px-4"
        >
          {eyebrow ? (
            <p data-slot="composer-options-eyebrow" className="eyebrow mb-2 text-soft-foreground">
              {eyebrow}
            </p>
          ) : null}
          {/* Container-keyed columns: the panel is as wide as the composer, not the viewport. */}
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 @md:grid-cols-2">
            {rows.map((row) => (
              <div
                key={row.id}
                data-slot="composer-option"
                data-option={row.id}
                className={cn(
                  'grid min-h-8 grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-3',
                  row.wide && 'col-span-full',
                )}
              >
                <span className="truncate text-xs text-muted-foreground">{row.label}</span>
                {/* No wrapping: a pill that does not fit truncates (its `title` has the rest). */}
                <span className="flex min-w-0 items-center gap-1">{row.control}</span>
              </div>
            ))}
            {onReset ? (
              <div className="col-span-full flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-slot="composer-options-reset"
                  className="text-soft-foreground"
                  onClick={onReset}
                >
                  Reset to defaults
                </Button>
              </div>
            ) : null}
          </div>
          {note ? <div className="mt-2 text-xs text-muted-foreground">{note}</div> : null}
        </PopoverContent>
      </Popover>
      {modified ? (
        <span data-slot="composer-options-summary" className="flex min-w-0 flex-wrap items-center gap-x-1 text-label text-muted-foreground">
          {summary.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 ? <span aria-hidden="true" className="text-soft-foreground">·</span> : null}
              <button
                type="button"
                data-summary={item.id}
                disabled={disabled}
                aria-label={`${item.label} — change in Options`}
                onClick={() => setOpen(true)}
                className="rounded-sm whitespace-nowrap hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </span>
      ) : null}
    </>
  )
}

/** The box's current width while the panel is open; `null` when there is nothing to measure. */
function useBoundsWidth(boundsRef: RefObject<HTMLElement | null> | undefined, open: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = boundsRef?.current
    if (!open || !element) return
    const measure = () => setWidth(element.getBoundingClientRect().width || null)
    measure()
    // jsdom has no ResizeObserver; the first measurement is all a test needs.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [boundsRef, open])
  return width
}
