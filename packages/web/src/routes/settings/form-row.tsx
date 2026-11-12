import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The one form grammar every settings page shares (design doc, Proposal 9 "Form rows and
 * saving"): a card of rows, each row label + description on the left and the control on the
 * right, and ONE save model — controls save on change and say "Saved" inline for two seconds;
 * text fields save on blur or Enter (⌘↵ in a textarea). No per-field Save or Reset buttons.
 */

const SAVED_FLASH_MS = 2000

/** `[saved, flash]`: call `flash()` after a successful write and `saved` is true for two seconds. */
export function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const flash = React.useCallback(() => {
    setSaved(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaved(false), SAVED_FLASH_MS)
  }, [])
  return [saved, flash]
}

/** The inline confirmation: a live region that stays mounted so the word is announced when it
 *  appears. No `role="status"` — that is the toaster's, and two of them would be ambiguous. */
export function SavedIndicator({ visible, label = 'Saved' }: { visible: boolean; label?: string }) {
  return (
    <span aria-live="polite" data-slot="saved-indicator" data-visible={visible ? '' : undefined} className="text-meta font-medium text-success">
      {visible ? label : null}
    </span>
  )
}

/** Enter in an input, ⌘↵/Ctrl+↵ in a textarea: the keyboard's "commit this field". */
export function isCommitKey(event: React.KeyboardEvent, multiline = false): boolean {
  if (event.key !== 'Enter') return false
  return multiline ? event.metaKey || event.ctrlKey : !event.shiftKey
}

export function SettingsCard({
  id,
  title,
  action,
  description,
  slot,
  children,
  className,
}: {
  id?: string
  title: React.ReactNode
  /** Right side of the header: a count chip, a toggle, a small button. */
  action?: React.ReactNode
  description?: React.ReactNode
  slot?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      data-slot={slot ?? 'settings-card'}
      // `scroll-mt`: a `#card` anchor from a redirect lands below the sticky mobile bar.
      className={cn('scroll-mt-16 overflow-hidden rounded-[10px] border border-border bg-card', className)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-ui font-semibold text-foreground">{title}</h2>
        {action ? <div className="ml-auto flex items-center gap-2">{action}</div> : null}
        {description ? <p className="basis-full text-meta text-muted-foreground">{description}</p> : null}
      </header>
      <div data-slot="settings-card-rows" className="flex flex-col divide-y divide-border">{children}</div>
    </section>
  )
}

export function FormRow({
  label,
  description,
  htmlFor,
  saved = false,
  stacked = false,
  slot,
  children,
  className,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  /** Makes the label a real `<label>` for the control. */
  htmlFor?: string
  /** Show the inline "Saved" beside the control. */
  saved?: boolean
  /** Control under the label instead of beside it — textareas, pickers, tables. */
  stacked?: boolean
  slot?: string
  children?: React.ReactNode
  className?: string
}) {
  const Label = htmlFor ? 'label' : 'span'
  return (
    <div
      data-slot={slot ?? 'form-row'}
      data-saved={saved ? '' : undefined}
      className={cn(
        'flex gap-4 px-4 py-3 text-ui',
        stacked ? 'flex-col' : 'flex-col sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="block font-medium text-foreground">
          {label}
        </Label>
        {description ? <p className="text-meta text-muted-foreground">{description}</p> : null}
      </div>
      {children !== undefined ? (
        <div className={cn('flex min-w-0 items-center gap-2.5', stacked ? 'flex-col items-stretch' : 'shrink-0')}>
          {children}
          <SavedIndicator visible={saved} />
        </div>
      ) : null}
    </div>
  )
}

/** A one-line note under a card's rows (the "Stored in ~/.cezar" kind). */
export function CardNote({ children, slot, tone = 'soft' }: { children: React.ReactNode; slot?: string; tone?: 'soft' | 'danger' }) {
  return (
    <p data-slot={slot} className={cn('px-4 py-2.5 text-meta', tone === 'danger' ? 'text-danger' : 'text-soft-foreground')}>
      {children}
    </p>
  )
}
