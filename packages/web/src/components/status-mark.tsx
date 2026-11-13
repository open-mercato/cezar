import { CircleCheckIcon, CirclePauseIcon, CircleSlashIcon, CircleXIcon, type LucideIcon } from 'lucide-react'

import { StatusDot } from '@/components/status-dot'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import type { Attention } from '@/lib/attention'
import { cn } from '@/lib/utils'

/**
 * A closed state's mark: a glyph whose SHAPE carries the outcome, so done / failed / cancelled /
 * idle never differ by colour alone (WCAG 1.4.1). The tone colour stays (owner, 2026-11-12).
 */
export type StatusMarkState = 'done' | 'failed' | 'cancelled' | 'idle'

/** Read from the attention bucket and label — never from the tone, which is only the colour. */
export function statusMarkState(attention: Pick<Attention, 'bucket' | 'label'>): StatusMarkState | undefined {
  if (attention.bucket === 'error') return 'failed'
  if (attention.bucket !== 'none') return undefined
  if (attention.label === 'done') return 'done'
  if (attention.label === 'cancelled') return 'cancelled'
  if (attention.label === 'closed · idle') return 'idle'
  return undefined
}

const GLYPH: Record<StatusMarkState, LucideIcon> = {
  done: CircleCheckIcon,
  failed: CircleXIcon,
  cancelled: CircleSlashIcon,
  // Paused, not broken: Continue still picks an idle-closed run up.
  idle: CirclePauseIcon,
}

// Ink ≥3:1 against the row in both themes (1.4.11): `--success` is a fill (2.5:1 on white), so done
// uses its per-theme ink token, like amber's `--pending-strong`.
const INK: Record<StatusMarkState, string> = {
  done: 'text-success-strong',
  failed: 'text-danger',
  cancelled: 'text-soft-foreground',
  idle: 'text-conflict',
}

/**
 * The glyph (or, for a state that is still open, the plain `StatusDot`), named by `role="img"`.
 * `showLabel` prints the word beside it — the Archived view, where outcomes mix; otherwise a
 * one-line tooltip carries the word for pointer users and the row title's `StatusDescription`
 * carries it for keyboard and screen-reader users, so the mark adds no tab stop.
 */
export function StatusMark({
  attention,
  showLabel = false,
  className,
}: {
  attention: Attention
  showLabel?: boolean
  className?: string
}) {
  const state = statusMarkState(attention)
  const Glyph = state ? GLYPH[state] : undefined
  const mark =
    state && Glyph ? (
      <span
        data-slot="status-mark"
        data-state={state}
        data-tone={attention.tone}
        role="img"
        aria-label={attention.label}
        className={cn('inline-flex shrink-0', INK[state])}
      >
        <Glyph className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </span>
    ) : (
      <StatusDot tone={attention.tone} pulse={attention.pulse} role="img" aria-label={attention.label} />
    )

  if (showLabel) {
    return (
      <span className={cn('inline-flex items-center gap-1.5', className)}>
        {mark}
        {/* Hidden from the a11y tree: the mark already names the state, once. */}
        <span data-slot="status-mark-label" aria-hidden="true" className="text-label text-muted-foreground">
          {attention.label}
        </span>
      </span>
    )
  }
  return (
    <IconTooltip label={attention.label} side="top">
      <span className={cn('inline-flex items-center', className)}>{mark}</span>
    </IconTooltip>
  )
}

/**
 * The state as the row title link's accessible DESCRIPTION (`aria-describedby={id}`): announced
 * with the task on focus, while the link's name stays the title. `hidden` keeps it out of both
 * the layout and the name; a describedby reference still reads it.
 */
export function StatusDescription({ id, attention }: { id: string; attention: Pick<Attention, 'label'> }) {
  return (
    <span id={id} hidden data-slot="status-description">
      {attention.label}
    </span>
  )
}
