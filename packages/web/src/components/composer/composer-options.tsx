import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

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
  /** Spans the whole grid — a note, or a control too wide for a third of it. */
  wide?: boolean
}

/**
 * The composer's "Options ⌄" button and its popover: a three-column grid of labelled rows on a
 * desktop, one column on a phone. A popover rather than a dialog — nothing here blocks the
 * prompt, and dismissing it never discards a choice (every row writes straight to the host).
 */
export function ComposerOptions({
  eyebrow,
  rows,
  note,
  onReset,
  open,
  onOpenChange,
  onOpenAutoFocus,
  disabled = false,
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
  disabled?: boolean
}) {
  if (rows.length === 0) return null
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-slot="composer-options-trigger"
          aria-label="Options"
          disabled={disabled}
          className="h-8 gap-1 px-2 text-xs font-medium text-muted-foreground pointer-coarse:max-md:h-11"
        >
          Options
          <ChevronDownIcon aria-hidden="true" className="size-3 text-soft-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        data-slot="composer-options"
        aria-label="Options"
        onOpenAutoFocus={onOpenAutoFocus}
        className="w-[720px] max-w-[calc(100vw-2rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto overscroll-contain p-3 md:px-4"
      >
        {eyebrow ? (
          <p data-slot="composer-options-eyebrow" className="eyebrow mb-2 text-soft-foreground">
            {eyebrow}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2 md:grid-cols-3">
          {rows.map((row) => (
            <div
              key={row.id}
              data-slot="composer-option"
              data-option={row.id}
              className={cn(
                'flex min-h-8 items-center justify-between gap-3',
                row.wide && 'col-span-full',
              )}
            >
              <span className="shrink-0 text-xs text-muted-foreground">{row.label}</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-1">{row.control}</span>
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
  )
}
