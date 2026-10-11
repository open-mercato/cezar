import { hashKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ArrowUpRightIcon, StarIcon } from 'lucide-react'

import { queryKeys, useStarCount, useWorkspaceConfig } from '@/api/queries'
import { useDashboardInsights } from '@/api/dashboard-insights'
import type { ApiRun, RunStatus } from '@open-mercato/cezar-api-client'
import {
  CEZAR_REPO_URL,
  STAR_ASK_MIN_SUCCESSES,
  STAR_ASK_PENDING_MS,
  STAR_ASK_SETTLE_MS,
  countSuccesses,
  diffSuccessTransition,
  formatStarCount,
  isUserPresent,
  mayAskForStar,
  readStarAsk,
  writeStarAsk,
} from '@/lib/star-promo'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

const INTERACTIONS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'checkbox')
}
const otherDialogOpen = () => document.querySelector('[role="dialog"],[role="alertdialog"]') !== null

/**
 * The star ask: a dialog, at most three times per browser, and only when we are sure two things
 * are true — the person really uses cezar (a run just ended well, and at least
 * `STAR_ASK_MIN_SUCCESSES` have), and they are at the screen right now (tab visible, window
 * focused, a pointer or key moved within the last minute, not typing, nothing else open).
 *
 * A success that lands while they are away is held for `STAR_ASK_PENDING_MS` and offered when
 * they come back, after a short settle so it never opens under a click in flight.
 *
 * It watches the cached run list rather than opening its own listener, for the same reason
 * `RunNotifications` does. Statuses are tracked UNCONDITIONALLY, before any gate, so a run that
 * was already finished when this mounted is never a transition and can never trigger the ask.
 *
 * `CEZ_NO_BANNER=1` reaches the browser as the star-count route answering `available: false`,
 * which is also what offline looks like — either way, no ask.
 */
export function StarPromo() {
  const queryClient = useQueryClient()
  const workspaceConfig = useWorkspaceConfig()
  const branding = workspaceConfig.data?.branding
  const customBranding = branding !== undefined && (
    branding.name !== 'cezar' || branding.logoUrl !== null
  )
  const starCount = useStarCount(workspaceConfig.data !== undefined && !customBranding)
  const allowed = !customBranding && starCount.data?.available === true
  const count = !customBranding && starCount.data?.available ? (starCount.data.count ?? null) : null
  const [open, setOpen] = useState(false)

  // Refs, not effect dependencies: rebuilding the cache subscription when the count resolves
  // would lose the status map, and with it the "never replay an old success" guarantee.
  const allowedRef = useRef(allowed)
  allowedRef.current = allowed
  const statusesRef = useRef<ReadonlyMap<string, RunStatus>>(new Map())
  const pendingSinceRef = useRef<number | null>(null)
  const lastInteractionRef = useRef(0)

  useEffect(() => {
    const listHash = hashKey(queryKeys.runs.list())
    let settle: ReturnType<typeof setTimeout> | undefined

    const present = () =>
      isUserPresent({
        now: Date.now(),
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        lastInteractionAt: lastInteractionRef.current,
        typing: isTyping(),
        dialogOpen: otherDialogOpen(),
      })

    const tryAsk = () => {
      const since = pendingSinceRef.current
      if (since === null || settle) return
      if (Date.now() - since > STAR_ASK_PENDING_MS) {
        pendingSinceRef.current = null
        return
      }
      if (!present()) return
      settle = setTimeout(() => {
        settle = undefined
        const record = readStarAsk()
        if (pendingSinceRef.current === null || !present() || !allowedRef.current) return
        if (!mayAskForStar(record, Date.now())) {
          pendingSinceRef.current = null
          return
        }
        pendingSinceRef.current = null
        // Recorded BEFORE it opens: a throw between the two costs one user an ask, while the
        // other order could cost every user a dialog that repeats forever.
        writeStarAsk({ ...record!, asks: record!.asks + 1, lastAskedAt: new Date().toISOString() })
        setOpen(true)
      }, STAR_ASK_SETTLE_MS)
    }

    const observe = (runs: readonly ApiRun[] | undefined): void => {
      const { succeeded, statuses } = diffSuccessTransition(statusesRef.current, runs)
      statusesRef.current = statuses
      if (!succeeded || !allowedRef.current) return
      if (countSuccesses(runs) < STAR_ASK_MIN_SUCCESSES) return
      if (!mayAskForStar(readStarAsk(), Date.now())) return
      pendingSinceRef.current = Date.now()
      tryAsk()
    }

    const onInteraction = () => {
      lastInteractionRef.current = Date.now()
      tryAsk()
    }
    for (const type of INTERACTIONS) window.addEventListener(type, onInteraction, { passive: true })
    document.addEventListener('visibilitychange', tryAsk)
    window.addEventListener('focus', tryAsk)

    // Seed silently: with an empty previous map nothing can be a transition.
    observe(queryClient.getQueryData<ApiRun[]>(queryKeys.runs.list()))
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== listHash || event.type !== 'updated') return
      observe(event.query.state.data as ApiRun[] | undefined)
    })
    return () => {
      unsubscribe()
      clearTimeout(settle)
      for (const type of INTERACTIONS) window.removeEventListener(type, onInteraction)
      document.removeEventListener('visibilitychange', tryAsk)
      window.removeEventListener('focus', tryAsk)
    }
  }, [queryClient])

  return customBranding ? null : <StarAskDialog open={open} onOpenChange={setOpen} count={count} />
}

/** The record update for each way out — every one of them is a single, equal-weight click. */
function answer(outcome: 'starred' | 'never') {
  const record = readStarAsk()
  if (record) writeStarAsk({ ...record, outcome })
}

export function StarAskDialog({
  open,
  onOpenChange,
  count,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number | null
}) {
  // Their own last 30 days are the argument; fetched only while the dialog is up.
  const insights = useDashboardInsights('30d', open)
  const delivered = insights.data?.delivered
  // A zero argues against the ask ("0 PRs opened"), so only what they actually got is shown.
  const stats =
    delivered && delivered.completedTasks > 0
      ? [
          { label: 'Tasks done', n: delivered.completedTasks, value: delivered.completedTasks.toLocaleString('en-US') },
          { label: 'PRs opened', n: delivered.prsOpened, value: delivered.prsOpened.toLocaleString('en-US') },
          { label: 'Lines written', n: delivered.additions, value: `+${delivered.additions.toLocaleString('en-US')}` },
        ].filter((stat) => stat.n > 0)
      : null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="star-ask"
        className="gap-0 overflow-hidden p-0 sm:max-w-[440px]"
      >
        <div className="relative flex h-36 items-center justify-center overflow-hidden border-b bg-card-2">
          {/* Two separate glows, lime and violet. The brand gradient blurred over near-black reads
              as olive mud; kept apart, each stays its own colour. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(circle_at_22%_35%,color-mix(in_oklab,var(--accent-lime)_32%,transparent),transparent_55%),radial-gradient(circle_at_80%_70%,color-mix(in_oklab,var(--violet)_38%,transparent),transparent_55%)]"
          />
          <div aria-hidden="true" className="relative flex items-center gap-4">
            <BrandMark height={52} className="text-foreground" />
            <span className="flex size-12 items-center justify-center rounded-full border bg-card shadow-md">
              <StarIcon className="size-6 fill-current text-pending-strong" />
            </span>
          </div>
          {count !== null && (
            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-card/80 px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground backdrop-blur">
              ⭐ {formatStarCount(count)} stars on GitHub
            </span>
          )}
        </div>
        <div className="space-y-4 p-6">
          <div className="space-y-2">
            <span className="section-mark block font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Open source · MIT
            </span>
            <DialogTitle className="text-xl font-semibold tracking-tight">
              Is cezar pulling its weight?
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              cezar is free, open source and runs on your machine, with no account to create. A
              GitHub star is how other developers find it, and how we know what to keep building.
            </DialogDescription>
          </div>
          {stats && (
            <div className="rounded-lg border bg-card-2 p-3">
              <span className="block font-mono text-[10.5px] uppercase tracking-[0.12em] text-soft-foreground">
                Your last 30 days with cezar
              </span>
              <dl
                className="mt-2 grid gap-2"
                style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}
              >
                {stats.map((s) => (
                  <div key={s.label} className="flex min-w-0 flex-col-reverse">
                    <dt className="text-xs text-soft-foreground">{s.label}</dt>
                    <dd className="truncate text-lg font-semibold tabular-nums">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <Button asChild className="h-11 w-full text-sm font-semibold">
            <a
              href={CEZAR_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                answer('starred')
                onOpenChange(false)
              }}
            >
              <StarIcon className="size-4 fill-current" aria-hidden="true" />
              Star cezar on GitHub
              <ArrowUpRightIcon className="size-4" aria-hidden="true" />
            </a>
          </Button>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" className="min-h-11" onClick={() => onOpenChange(false)}>
              Maybe later
            </Button>
            <Button
              variant="ghost"
              className="min-h-11 text-soft-foreground"
              onClick={() => {
                answer('never')
                onOpenChange(false)
              }}
            >
              Don’t ask again
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
