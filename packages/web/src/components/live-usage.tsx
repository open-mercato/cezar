import { Fragment } from 'react'

import type { AgentAccountDetailsResponse, RunLiveUsage } from '@open-mercato/cezar-api-client'

import { compactTokens } from '@/lib/format'
import { useNow } from '@/lib/use-now'
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

/** A reading older than this is dimmed: plan windows are per account, and other tasks on it keep
 *  spending while this one idles. */
export const LIVE_USAGE_STALE_MS = 5 * 60_000

/** The account part from the on-demand identity route: the org tells accounts apart (one email can
 *  sign in to several Claude organizations), the email goes on hover. */
export function accountPart(details: AgentAccountDetailsResponse | undefined): LiveUsagePart | undefined {
  if (!details?.available) return undefined
  const field = (label: string) => details.fields.find((f) => f.label === label)?.value
  const email = field('Email')
  const text = field('Organization') ?? email
  return text === undefined ? undefined : { text, tone: 'neutral', ...(email ? { title: email } : {}) }
}

/** The header's gauge parts, e.g. `5h 81% left 2h19m`, `CTX 416k 41%`. A window that has
 *  already reset is dropped: its reading is stale and the next event replaces it. */
export function liveUsageParts(usage: RunLiveUsage | undefined, now = Date.now()): LiveUsagePart[] {
  if (usage === undefined) return []
  const parts: LiveUsagePart[] = []
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

/** The account, then plan usage windows and context fill: what Claude Code's own status line shows. */
export function LiveUsage({
  usage,
  account,
  className,
}: {
  usage: RunLiveUsage | undefined
  account?: LiveUsagePart
  className?: string
}) {
  const now = useNow(30_000)
  const gauges = liveUsageParts(usage, now)
  if (gauges.length === 0) return null
  const at = Date.parse(usage?.at ?? '')
  const stale = now - at > LIVE_USAGE_STALE_MS
  const parts = account ? [account, ...gauges] : gauges
  return (
    <span data-slot="live-usage" className={cn('font-mono tabular-nums', className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? ' · ' : null}
          <span
            data-tone={part.tone}
            data-stale={stale && part !== account ? '' : undefined}
            title={part !== account && stale ? `as of ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : part.title}
            className={cn(TONE_CLASS[part.tone], part !== account && stale && 'opacity-50')}
          >
            {part.text}
          </span>
        </Fragment>
      ))}
    </span>
  )
}
