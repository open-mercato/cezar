import {
  BanIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  HourglassIcon,
  LoaderIcon,
  MessageCircleQuestionIcon,
  RadarIcon,
  ScanEyeIcon,
  ShieldQuestionIcon,
  SparkleIcon,
  type LucideIcon,
} from 'lucide-react'

import type { Attention, AttentionKind, AttentionTone } from '@/lib/attention'
import { cn } from '@/lib/utils'

/**
 * The run's state as ONE mark — a glyph per kind, a colour per tone (sidebar redesign, "one
 * fact, one channel"). The glyph is what makes two states of one colour tell apart without a
 * legend; the colour says whose move it is; motion is spent only on what is moving right now
 * (the agent working, a question waiting) — review and a scheduled resume stand still.
 *
 * Replaces the status dot on every run surface (sidebar rows, the tables' pills, the palette,
 * the compare view). `StatusDot` stays for the places that never meant a run state (tools,
 * reference chips).
 */
const GLYPH: Record<AttentionKind, LucideIcon> = {
  running: LoaderIcon,
  monitoring: RadarIcon,
  waiting: MessageCircleQuestionIcon,
  permission: ShieldQuestionIcon,
  review: ScanEyeIcon,
  scheduled: ClockIcon,
  failed: CircleXIcon,
  done: CircleCheckIcon,
  queued: HourglassIcon,
  cancelled: BanIcon,
  unseen: SparkleIcon,
}

/** Ink, not fill: the amber dot fill fails as ink on light, so the mark uses the ink token. */
const INK: Record<AttentionTone, string> = {
  violet: 'text-violet',
  pending: 'text-pending-strong',
  danger: 'text-danger',
  success: 'text-success',
  neutral: 'text-soft-foreground',
}

export function StatusMark({
  attention,
  className,
  ...props
}: React.ComponentProps<'span'> & { attention: Attention }) {
  const Icon = GLYPH[attention.kind]
  return (
    <span
      data-slot="status-mark"
      data-kind={attention.kind}
      data-tone={attention.tone}
      role="img"
      aria-label={attention.label}
      title={attention.label}
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', INK[attention.tone], className)}
      {...props}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'size-3.5',
          // Slow, not a loading spinner: the agent is at work, and the mark should read as
          // calm presence rather than a wait cursor.
          attention.kind === 'running' && 'animate-spin [animation-duration:2.4s]',
          attention.pulse && attention.kind !== 'running' && 'animate-pulse',
        )}
      />
    </span>
  )
}
