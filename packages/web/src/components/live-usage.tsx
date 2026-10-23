import { Fragment } from 'react'

import type { RunLiveUsage } from '@open-mercato/cezar-api-client'

import { compactTokens } from '@/lib/format'
import { cn } from '@/lib/utils'

const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

export type LiveUsageTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface LiveUsagePart {
  text: string
  tone: LiveUsageTone
  /** Hover text, e.g. the account's email under its org name. */
  title?: string
}

const TONE_CLASS: Record<LiveUsageTone, string> = {
  neutral: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
}

/** Green below half used, amber from half, red from 80%. */
function toneFor(usedFraction: number): LiveUsageTone {
  if (usedFraction >= 0.8) return 'danger'
  if (usedFraction >= 0.5) return 'warning'
  return 'success'
}

/** `2h19m`, `3d11h`, `42m`: the remaining time in Claude Code's status line style. */
export function timeLeft(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

/** The header's status-line parts, e.g. `WP-Stars`, `5h 81% left 2h19m`, `CTX 416k 41%`. A window that has
 *  already reset is dropped: its reading is stale and the next event replaces it. */
export function liveUsageParts(usage: RunLiveUsage | undefined, now = Date.now()): LiveUsagePart[] {
  if (usage === undefined) return []
  const parts: LiveUsagePart[] = []
  // The org tells accounts apart: one email can sign in to several Claude organizations.
  const account = usage.account?.org ?? usage.account?.email
  if (account !== undefined) {
    parts.push({ text: account, tone: 'neutral', ...(usage.account?.email ? { title: usage.account.email } : {}) })
  }
  for (const limit of usage.limits ?? []) {
    const resetsIn = Date.parse(limit.resetsAt) - now
    if (!(resetsIn > 0)) continue
    const label = WINDOW_LABELS[limit.window] ?? limit.window.replace(/_/g, ' ')
    parts.push({
      text: `${label} ${Math.round((1 - limit.utilization) * 100)}% left ${timeLeft(resetsIn)}`,
      tone: toneFor(limit.utilization),
    })
  }
  if (usage.contextTokens !== undefined) {
    const fill = usage.contextWindow ? usage.contextTokens / usage.contextWindow : undefined
    parts.push({
      text: `CTX ${compactTokens(usage.contextTokens)}${fill === undefined ? '' : ` ${Math.round(fill * 100)}%`}`,
      tone: toneFor(fill ?? 0),
    })
  }
  return parts
}

/** Plan usage windows and context fill, the numbers Claude Code's own status line shows. */
export function LiveUsage({ usage, className }: { usage: RunLiveUsage | undefined; className?: string }) {
  const parts = liveUsageParts(usage)
  if (parts.length === 0) return null
  return (
    <span data-slot="live-usage" className={cn('font-mono tabular-nums', className)}>
      {parts.map((part, index) => (
        <Fragment key={part.text}>
          {index > 0 ? ' · ' : null}
          <span data-tone={part.tone} title={part.title} className={TONE_CLASS[part.tone]}>
            {part.text}
          </span>
        </Fragment>
      ))}
    </span>
  )
}
