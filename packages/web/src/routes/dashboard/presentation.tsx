import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { shortAge } from '@/lib/format'

// The landing's eyebrow: mono caps behind a violet `//` (`section-mark`, styles/index.css).
// A pseudo-element keeps it out of textContent (tests, the export's module titles); its empty
// alt text keeps it out of the accessible name.
export const widgetHeading =
  'section-mark eyebrow text-muted-foreground'
// One header bar for every module, so the cards line up as a single system.
export const widgetHeader =
  'flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2.5'
// A <details> summary without the browser's triangle: a chevron that turns when the
// disclosure opens. The rotation keys off `details[open] > summary`, the chevron's own
// disclosure, so an open outer <details> never turns a nested one.
export const disclosureSummary =
  'flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-muted-foreground transition-colors select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden'
export function DisclosureChevron() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="size-3.5 shrink-0 text-soft-foreground transition-transform duration-150 motion-reduce:transition-none [details[open]>summary>&]:rotate-90"
    />
  )
}
// Filter label beside a FilterSelect: quiet, so the value reads first.
export const filterLabel = 'flex items-center gap-2 text-label text-muted-foreground'

export interface FilterOption<T extends string> {
  value: T
  label: string
}

/**
 * A module's filter: the cockpit's Radix select (redesign 2026-11 — native `<select>` is
 * retired). The trigger carries `aria-label`, so tests and assistive tech address it as the
 * `combobox` named by its label. The export reads the choice off `data-export-filter` /
 * `data-export-value` (`export.ts`) — a Radix trigger is a button, which the printable report
 * strips, so the label and value ride on the wrapper rather than on the control.
 */
export function FilterSelect<T extends string>({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string
  value: T
  onValueChange: (value: T) => void
  options: readonly FilterOption<T>[]
}) {
  const current = options.find((option) => option.value === value)
  return (
    <span className={filterLabel} data-export-filter={label} data-export-value={current?.label ?? ''}>
      {label}
      <Select value={value} onValueChange={(next) => onValueChange(next as T)}>
        <SelectTrigger aria-label={label} size="sm" className="bg-card-2 font-mono text-xs no-hover:min-h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  )
}

/** The two reporting windows every module offers. */
export const PERIOD_OPTIONS: readonly FilterOption<'7d' | '30d'>[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]

// Flat tile, status carried by a hairline rule on top (`metricAccents`) instead of a
// full-surface gradient — the gradients read as mud on the near-black background.
export const metricSurface =
  'relative min-w-0 overflow-hidden rounded-lg border bg-card-2 p-4 transition-colors before:absolute before:inset-x-0 before:top-0 before:h-px before:opacity-80 hover:border-foreground/20 hover:bg-muted/40 sm:p-5'
export const metricAccents = {
  violet: 'before:bg-violet',
  info: 'before:bg-info',
  success: 'before:bg-success',
  danger: 'before:bg-danger',
  primary: 'before:bg-primary',
  neutral: 'before:bg-border',
} as const
export function MetricContent({
  label,
  value,
  icon,
  children,
}: {
  label: string
  value: ReactNode
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <span className="flex w-full items-center justify-between gap-2">
        <span className="eyebrow text-muted-foreground">
          {label}
        </span>
        <span className="text-soft-foreground" aria-hidden="true">
          {icon}
        </span>
      </span>
      <span className="mt-4 block text-4xl font-semibold leading-none tracking-tight tabular-nums">
        {value}
      </span>
      <span className="mt-3 block text-label text-muted-foreground">{children}</span>
    </>
  )
}

/** A relative age whose exact instant is one hover away — the Radix tooltip, not a native
 *  `title`. Not a tab stop: a page of ages would become a page of focus stops, and the
 *  `<time dateTime>` already carries the instant for assistive tech. */
export function Timestamp({ at, children }: { at: string; children: ReactNode }) {
  return (
    <IconTooltip label={new Date(at).toLocaleString()}>
      <time dateTime={at}>{children}</time>
    </IconTooltip>
  )
}

export function Freshness({ at }: { at: string }) {
  return <Timestamp at={at}>Updated {shortAge(at)} ago</Timestamp>
}
