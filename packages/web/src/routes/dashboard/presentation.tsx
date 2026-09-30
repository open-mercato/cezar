import type { ReactNode } from 'react'
import { shortAge } from '@/lib/format'

export const widgetHeading = 'text-sm font-semibold'
export const metricSurface =
  'relative min-w-0 overflow-hidden rounded-xl border bg-gradient-to-br to-transparent p-4 sm:p-5'
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
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="rounded-lg bg-background/70 p-2" aria-hidden="true">
          {icon}
        </span>
      </span>
      <span className="mt-3 block text-3xl font-semibold tracking-tight tabular-nums">
        {value}
      </span>
      <span className="mt-4 block text-xs text-muted-foreground">{children}</span>
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
