import { useEffect, useMemo, useState } from 'react'

import { occurrencesBetween, type AutomationKind, type AutomationSchedule } from '@open-mercato/cezar-api-client'
import { Card } from '@/components/ui/card'
import { dayTime, relativeIn } from '@/lib/automation-format'

const DAY = 86_400_000

/**
 * The editor's right-hand preview (spec 2026-09-14-automations-redesign § UI/UX 4): the next
 * five instants the form's schedule fires, in the server's zone, recomputed on every keystroke —
 * or, for a poll, a sentence about how it polls. `now` is a prop so a test can pin the clock;
 * the live card re-reads it once a minute so "in 18h" does not go stale on a long edit.
 */
export function NextRunsPreview({
  kind,
  schedule,
  intervalSeconds,
  timeZone,
  now,
}: {
  kind: AutomationKind
  schedule: AutomationSchedule
  intervalSeconds: number
  timeZone: string
  now?: number
}) {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (now !== undefined) return
    const timer = setInterval(() => setTick(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [now])
  const at = now ?? tick
  const runs = useMemo(
    () => (kind === 'schedule' ? occurrencesBetween(schedule, at, at + 9 * DAY, timeZone, 5) : []),
    [kind, schedule, at, timeZone],
  )
  return (
    <Card flush data-slot="next-runs-preview" className="pt-3 pb-2">
      <div className="px-3.5 pb-2 text-[11px] font-semibold tracking-[.05em] uppercase text-soft-foreground">
        {kind !== 'schedule' ? 'How it polls' : 'Next 5 runs'}
      </div>
      {kind !== 'schedule' ? (
        <p className="m-0 px-3.5 pb-1.5 text-[12.5px] leading-[1.5] text-muted-foreground">
          {kind === 'tracker'
            ? <>Checks the project tracker every {Math.round(intervalSeconds / 60)} min while cezar is open. No webhook or public URL required.</>
            : <>Checks GitHub every {Math.round(intervalSeconds / 60)} min while cezar is open, through your <code className="text-xs">gh</code>. No webhook or public URL required.</>}
        </p>
      ) : runs.length === 0 ? (
        <p className="m-0 px-3.5 pb-1.5 text-[12.5px] leading-[1.5] text-muted-foreground">Nothing in the next nine days.</p>
      ) : (
        runs.map((ms) => (
          <div key={ms} data-slot="next-run" className="flex gap-2.5 px-3.5 py-[5px] text-[13px]">
            <span className="w-[82px] shrink-0 font-mono text-xs font-medium whitespace-nowrap text-foreground tabular-nums">
              {dayTime(ms, timeZone)}
            </span>
            <span className="text-[11.5px] whitespace-nowrap text-soft-foreground">{relativeIn(ms, at)}</span>
          </div>
        ))
      )}
    </Card>
  )
}
