import type { ComponentProps, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { shortAge } from '@/lib/format'

// The landing's eyebrow: mono caps behind a violet `//`. The prefix is a pseudo-element so
// it never reaches a heading's text (tests, screen readers, the export's module titles).
export const widgetHeading =
  "font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground before:mr-1.5 before:tracking-normal before:text-violet before:content-['//']"
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
export const filterLabel = 'flex items-center gap-2 text-xs text-muted-foreground'
// A native <select> (keyboard, mobile pickers and the export's filter capture all rely on
// it) with the browser's arrow replaced by the cockpit's chevron. The focus ring is the
// cockpit's (lime dark / ink light): a bare select gets the browser's blue, and blue
// means `--info` here.
export function FilterSelect({ className = '', ...props }: ComponentProps<'select'>) {
  return (
    <span className="relative inline-flex">
      <select
        {...props}
        className={`h-9 cursor-pointer appearance-none rounded-md border bg-card-2 pr-8 pl-3 font-mono text-xs text-foreground outline-none transition-colors hover:border-foreground/20 hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 no-hover:min-h-11 ${className}`}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
      />
    </span>
  )
}
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
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
        <span className="text-soft-foreground" aria-hidden="true">
          {icon}
        </span>
      </span>
      <span className="mt-4 block text-4xl font-semibold leading-none tracking-tight tabular-nums">
        {value}
      </span>
      <span className="mt-3 block text-xs text-soft-foreground">{children}</span>
    </>
  )
}
export function Freshness({ at }: { at: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      Updated {shortAge(at)} ago
    </time>
  )
}
