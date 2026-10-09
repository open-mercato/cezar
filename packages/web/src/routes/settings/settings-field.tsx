import { TriangleAlertIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { FieldDescription, FieldTitle } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * The settings chassis (cockpit concept 2). Every section renders through these few parts, so
 * Settings reads as ONE surface across the project/global boundary:
 *
 *   <SettingsPane>                      the section's column — groups separated by space
 *     <SettingsGroup title description> one titled block = ONE card, rows split by hairlines
 *       <SettingsField title hint control={<Switch/>}>…</SettingsField>
 *     </SettingsGroup>
 *     <DangerZone>…</DangerZone>        destructive actions, last
 *   </SettingsPane>
 */

export function SettingsPane({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex w-full flex-col gap-8', className)} {...props} />
}

/** A titled block: heading + one-line description above ONE card whose children are rows. */
export function SettingsGroup({
  title,
  description,
  actions,
  children,
  className,
  cardClassName,
  bare = false,
  ...props
}: Omit<ComponentProps<'section'>, 'title'> & {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  cardClassName?: string
  /** No card: the children bring their own single surface (a table frame, an editor). */
  bare?: boolean
}) {
  return (
    <section data-slot="settings-group" className={cn('flex flex-col gap-3', className)} {...props}>
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            {title ? <h2 className="text-[15px] font-semibold text-foreground">{title}</h2> : null}
            {description ? (
              <p className="max-w-prose text-[13px] text-pretty text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {bare ? (
        children
      ) : (
        <Card flush className={cn('divide-y divide-border', cardClassName)}>
          {children}
        </Card>
      )}
    </section>
  )
}

/**
 * One labelled settings row — title, hint, control(s).
 *
 * `control` sits to the right of the text on wide screens (a switch, a stepper, a short select)
 * and drops below it on narrow ones; `children` always render underneath (wide inputs, notes).
 */
export function SettingsField({
  title,
  hint,
  control,
  htmlFor,
  children,
  className,
}: {
  title: ReactNode
  hint?: ReactNode
  control?: ReactNode
  /** Makes the title a real <label> for the control with this id. */
  htmlFor?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div data-slot="settings-field" className={cn('flex flex-col gap-3 px-5 py-4', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <FieldTitle className="text-[13.5px]">
            {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <h3>{title}</h3>}
          </FieldTitle>
          {hint ? (
            <FieldDescription className="max-w-prose text-[13px] text-pretty">{hint}</FieldDescription>
          ) : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-2 sm:pt-0.5">{control}</div> : null}
      </div>
      {children}
    </div>
  )
}

/** The small print under a control: what the value means right now, or why it is refused. */
export function SettingsNote({
  tone = 'muted',
  className,
  ...props
}: ComponentProps<'p'> & { tone?: 'muted' | 'danger' }) {
  return (
    <p
      className={cn('text-xs text-pretty', tone === 'danger' ? 'text-danger' : 'text-muted-foreground', className)}
      {...props}
    />
  )
}

/** A quiet definition list for key/value facts. Children are <SettingsFact> rows. */
export function SettingsFacts({ className, ...props }: ComponentProps<'dl'>) {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-4 text-[13.5px] sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-y-3',
        className,
      )}
      {...props}
    />
  )
}

export function SettingsFact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-[13px] text-muted-foreground not-first:max-sm:pt-2">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  )
}

export interface SettingsSelectOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

/**
 * A shadcn Select with the native `<select>` calling convention the sections were written
 * against. Radix refuses an empty-string item value, so `''` (a real value here: "auto",
 * "follow the checked-out branch") is carried through a sentinel and handed back as `''`.
 */
const EMPTY = '__empty__'

export function SettingsSelect({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  className,
  title,
  footer,
  size = 'default',
  'aria-label': ariaLabel,
  'data-slot': dataSlot,
  ...rest
}: {
  value: string
  onChange: (value: string) => void
  options: readonly SettingsSelectOption[]
  disabled?: boolean
  placeholder?: string
  className?: string
  title?: string
  /** A non-selectable last line (a catalog status). */
  footer?: ReactNode
  size?: 'sm' | 'default'
  'aria-label': string
  'data-slot'?: string
} & Record<`data-${string}`, string | undefined>) {
  return (
    <Select
      value={value === '' ? EMPTY : value}
      onValueChange={(next) => onChange(next === EMPTY ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger
        size={size}
        aria-label={ariaLabel}
        title={title}
        {...rest}
        data-slot={dataSlot ?? 'select-trigger'}
        data-value={value}
        className={cn('w-full sm:w-56', className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value === '' ? EMPTY : option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
        {footer ? <div className="px-2 py-1.5 text-xs text-muted-foreground">{footer}</div> : null}
      </SelectContent>
    </Select>
  )
}

/** The pending state every section shares: the shape of a group, not a line of text. */
export function SettingsLoading({ label, ...props }: { label: string } & ComponentProps<'div'>) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3" {...props}>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <span className="sr-only">{label}</span>
    </div>
  )
}

export function SettingsError({
  title,
  children,
  action,
  ...props
}: { title: ReactNode; children?: ReactNode; action?: ReactNode } & Omit<ComponentProps<'div'>, 'title'>) {
  return (
    <Alert variant="destructive" {...props}>
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      {children ? <AlertDescription>{children}</AlertDescription> : null}
      {action ? <div className="col-start-2 pt-2">{action}</div> : null}
    </Alert>
  )
}

/** Destructive actions, clearly separated and always last. */
export function DangerZone({
  title = 'Danger zone',
  description,
  children,
}: {
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <SettingsGroup
      data-slot="danger-zone"
      title={title}
      description={description}
      cardClassName="border-danger/30 divide-danger/20"
    >
      {children}
    </SettingsGroup>
  )
}
