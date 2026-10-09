import { useState, type ComponentProps, type ReactNode } from 'react'
import { ChevronRight, Info, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { shortAge } from '@/lib/format'
import { cn } from '@/lib/utils'

// One header row for every module, so the cards line up as a single system. No rule under
// it: the card is the only surface, the heading and its content share it.
export const widgetHeading = 'text-[15px] leading-6 font-semibold text-foreground'
export const widgetHeader =
  'flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pt-4'
export const widgetBody = 'space-y-4 px-5 pt-3 pb-5 text-sm'
// Counts, freshness and other quiet facts beside a heading.
export const widgetMeta = 'text-xs text-muted-foreground tabular-nums'
// Class overrides that keep ui/table's parts on the dashboard's own grid: quiet header cells,
// a hairline above every body row (none under the header), cells that wrap.
export const tableHead = 'h-auto px-3 py-2.5 text-xs font-medium text-muted-foreground'
export const tableHeader = '[&_tr]:border-b-0'
export const tableHeaderRow = 'hover:bg-transparent'
export const tableBody = '[&_tr:last-child]:border-t'
export const tableRow = 'border-t border-b-0 border-border/70'
export const tableCell = 'whitespace-normal'
// A disclosure trigger: a chevron that turns when the disclosure opens. The rotation keys
// off the trigger's own `data-state`, so an open outer disclosure never turns a nested one.
export const disclosureSummary =
  'flex w-fit cursor-pointer items-center gap-1.5 rounded-sm text-[13px] text-muted-foreground transition-colors select-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
export function DisclosureChevron() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="size-3.5 shrink-0 text-soft-foreground transition-transform duration-150 motion-reduce:transition-none [[data-state=open]>&]:rotate-90"
    />
  )
}
// The content of a closed disclosure stays mounted (`forceMount`) and is only hidden by
// CSS: the export reads the rendered DOM and has always carried collapsed details.
export const disclosureContent = 'data-[state=closed]:hidden'
// A `Collapsible` with the dashboard's quiet chevron trigger. `open` + `onOpenChange`
// control it; `forceOpen` opens it when it turns true and closes it when it turns false,
// leaving the user free to toggle in between. The export turns the trigger into a heading
// (`exportHeading`, or its text).
export function Disclosure({
  summary,
  exportHeading,
  summaryClassName,
  open,
  onOpenChange,
  forceOpen,
  children,
  ...props
}: Omit<ComponentProps<typeof Collapsible>, 'open' | 'onOpenChange' | 'defaultOpen'> & {
  summary: ReactNode
  exportHeading?: string
  summaryClassName?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
}) {
  const [own, setOwn] = useState(!!forceOpen)
  const [forced, setForced] = useState(forceOpen)
  if (forced !== forceOpen) {
    setForced(forceOpen)
    setOwn(!!forceOpen)
  }
  return (
    <Collapsible
      {...props}
      open={open ?? own}
      onOpenChange={(next) => {
        setOwn(next)
        onOpenChange?.(next)
      }}
    >
      <CollapsibleTrigger
        className={cn(disclosureSummary, summaryClassName)}
        data-export-heading={exportHeading}
      >
        <DisclosureChevron />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className={disclosureContent}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
// Filter label beside a FilterSelect: quiet, so the value reads first.
export const filterLabel =
  'flex items-center gap-2 text-[13px] leading-normal font-normal text-muted-foreground'
// The cockpit's Select, sized for a widget header. There is no native <select> to read any
// more, so the trigger carries the chosen label in `data-export-filter` for the export's
// filter capture (export.ts); the filter's name is still the enclosing label's text.
export function FilterSelect<T extends string>({
  value,
  onValueChange,
  options,
  className,
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly { value: T; label: string }[]
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as T)}>
      <SelectTrigger
        size="sm"
        data-export-filter={options.find((option) => option.value === value)?.label ?? ''}
        className={cn(
          'cursor-pointer gap-1.5 bg-card pr-2.5 pl-3 text-[13px] text-foreground no-hover:min-h-11 dark:bg-card',
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-[13px]">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
// The long explanation behind a metric, one hover away. The button is dropped from the
// export; pair it with a <ReportNote> so the report and the CSV notes still carry the text.
export function InfoHint({
  label = 'How this is measured',
  children,
}: {
  label?: string
  children: ReactNode
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-export-exclude
            aria-label={label}
            className="text-soft-foreground hover:bg-transparent no-hover:size-11"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 text-left leading-relaxed text-pretty">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
// Text that belongs to the exported report only: hidden on screen, printed in the PDF
// (`.report-only`, export.ts) and collected into the CSV notes.
export function ReportNote({ children }: { children: ReactNode }) {
  return (
    <p aria-hidden="true" className="report-only sr-only">
      {children}
    </p>
  )
}
// KPI card: one surface, a big number, a quiet label and hint. Tone tints the whole card
// softly — violet for "needs a human", danger for failures — and only when there is something
// to say.
export const metricSurface =
  'group/metric relative flex min-w-0 flex-col rounded-xl border bg-card p-5 text-left shadow-xs transition-[background-color,border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40'
export const metricTones = {
  neutral: '',
  violet: 'border-violet/30 bg-violet/[0.07]',
  danger: 'border-danger/25 bg-danger/[0.06]',
} as const
export function MetricContent({
  label,
  value,
  icon,
  children,
}: {
  label: string
  value: ReactNode
  icon?: ReactNode
  children?: ReactNode
}) {
  return (
    <>
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        {icon ? (
          <span className="text-soft-foreground" aria-hidden="true">
            {icon}
          </span>
        ) : null}
      </span>
      <span className="mt-3 block text-[32px] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </span>
      {children ? (
        <span className="mt-3 block text-xs text-muted-foreground">{children}</span>
      ) : null}
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
// A problem or a status inside a module: soft tint, the action on the right.
export function Notice({
  tone = 'danger',
  action,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { tone?: 'danger' | 'pending' | 'neutral'; action?: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      {...props}
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg px-3 py-2 text-[13px]',
        tone === 'danger' ? 'bg-danger/8' : tone === 'pending' ? 'bg-pending/12' : 'bg-muted',
        className,
      )}
    >
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  )
}
// Loading placeholder shaped like a short list; `label` keeps the status announced.
export function WidgetSkeleton({
  label,
  rows = 3,
  className,
}: {
  label: string
  rows?: number
  className?: string
}) {
  return (
    <div role="status" className={cn('space-y-3', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2" aria-hidden="true">
          <Skeleton className="h-4" style={{ width: `${70 - i * 12}%` }} />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  )
}
export function WidgetEmpty({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon
  title: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <Empty className={cn('gap-2 p-6 md:p-8', className)}>
      <EmptyHeader className="gap-1">
        <EmptyMedia variant="icon" className="mb-1 size-9 text-muted-foreground [&_svg]:size-4">
          <Icon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-sm font-medium tracking-normal">{title}</EmptyTitle>
        {children ? (
          <EmptyDescription className="text-[13px]">{children}</EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}
