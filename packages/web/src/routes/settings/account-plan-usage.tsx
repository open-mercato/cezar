import { useId } from 'react'
import type { PlanUsageReport, PlanUsageWindow } from '@open-mercato/cezar-api-client'
import { usePlanUsage, usePlanUsageTracking, useSetPlanUsageTracking } from '@/api/plan-usage'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { approxPp, clockTime, exactPp } from '@/lib/plan-usage'

/** Settings → an account's plan limits and its tracking switch (session-usage design, screen 6). */

const sumConsumers = (w: PlanUsageWindow) => w.consumers.reduce((s, c) => s + c.estimatePp, 0)

function currentWindow(report: PlanUsageReport | undefined, key: string): PlanUsageWindow | undefined {
  return report?.windows.find((w) => w.current && w.account.key === key)
}

function weeklyReset(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${clockTime(iso)}`
}

/** `5-hour limit: N% used · resets HH:MM · cezar tasks and managers ≈ M% of it`. */
export function fiveHourLine(w: PlanUsageWindow | undefined): string {
  if (!w || !w.usedPercent) return 'no reading yet'
  return `${exactPp(w.usedPercent.last)} used · resets ${clockTime(w.resetsAt)} · cezar tasks and managers ${approxPp(sumConsumers(w))} of it, outside cezar ${exactPp(w.outsideCezarPp)}${unknownTail(w)}`
}

/** `Weekly limit: N% used · resets Mon 24 Nov 08:00 · this week: cezar ≈ X%, outside cezar Y%`. */
export function weeklyLine(w: PlanUsageWindow | undefined): string {
  if (!w || !w.usedPercent) return 'no reading yet'
  return `${exactPp(w.usedPercent.last)} used · resets ${weeklyReset(w.resetsAt)} · this week: cezar ${approxPp(sumConsumers(w))}, outside cezar ${exactPp(w.outsideCezarPp)}${unknownTail(w)}`
}

/** What no one can be named for stays visible, never folded into "outside cezar". */
function unknownTail(w: PlanUsageWindow): string {
  const parts = [
    w.beforeTrackingPp > 0 ? `before tracking ${exactPp(w.beforeTrackingPp)}` : '',
    w.untrackedPp > 0 ? `not tracked ${exactPp(w.untrackedPp)}` : '',
    w.unsplitPp > 0 ? `couldn't split ${exactPp(w.unsplitPp)}` : '',
    // Without it the named parts can exceed the amount used (QA F3).
    w.correctionPp > 0 ? `provider correction −${exactPp(w.correctionPp)}` : '',
  ].filter(Boolean)
  return parts.length ? `, ${parts.join(', ')}` : ''
}

export function AccountPlanUsage({ provider, accountId }: { provider: 'claude' | 'codex'; accountId: string }) {
  const key = `${provider}:${accountId}`
  const switchId = useId()
  const fiveHour = usePlanUsage({ kind: 'five-hour', account: key })
  const weekly = usePlanUsage({ kind: 'weekly', account: key })
  const tracking = usePlanUsageTracking()
  const setTracking = useSetPlanUsageTracking()
  const globalOff = tracking.data?.enabled === false
  const on = !globalOff && tracking.data?.accounts[key] !== false
  const retention = tracking.data?.retentionDays ?? 90

  return (
    <div data-slot="account-plan-usage" className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-2.5 text-label">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">5-hour limit</dt>
        <dd data-slot="account-plan-five-hour" className="min-w-0 text-foreground tabular-nums">
          {fiveHour.isPending ? 'Reading…' : fiveHour.isError ? 'unavailable' : fiveHourLine(currentWindow(fiveHour.data, key))}
        </dd>
        <dt className="text-muted-foreground">Weekly limit</dt>
        <dd data-slot="account-plan-weekly" className="min-w-0 text-foreground tabular-nums">
          {weekly.isPending ? 'Reading…' : weekly.isError ? 'unavailable' : weeklyLine(currentWindow(weekly.data, key))}
        </dd>
      </dl>
      <div className="flex items-start gap-3">
        <Switch
          id={switchId}
          data-slot="account-plan-tracking"
          checked={on}
          disabled={globalOff || tracking.isPending || setTracking.isPending}
          onCheckedChange={(enabled) =>
            setTracking.mutate({ account: key, enabled }, { onError: (error) => toast(error.message, { tone: 'danger' }) })
          }
        />
        <div className="min-w-0">
          <label htmlFor={switchId} className="font-medium text-foreground">Track plan limit usage</label>
          <p className="text-muted-foreground">
            Saves the limit readings on this computer (no prompts or code) so cezar can show which tasks used them. Kept {retention} days.
          </p>
          {globalOff ? (
            <p data-slot="account-plan-tracking-off" className="mt-0.5 text-muted-foreground">
              {tracking.data?.reason ?? 'Turned off on this computer (CEZ_USAGE_LOG=0).'}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
