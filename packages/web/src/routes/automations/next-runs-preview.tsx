import { useEffect, useMemo, useState } from 'react'

import { occurrencesBetween, type AutomationKind, type AutomationSchedule } from '@open-mercato/cezar-api-client'
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
    <section data-slot="next-runs-preview">
      <h2 className="pb-2 text-[15px] font-semibold">
        {kind !== 'schedule' ? 'How it polls' : 'Next 5 runs'}
      </h2>
      {kind !== 'schedule' ? (
        <p className="m-0 text-[13px] leading-relaxed text-pretty text-muted-foreground">
          {kind === 'tracker'
            ? <>Checks the project tracker every {Math.round(intervalSeconds / 60)} min while this cockpit is open. No webhook or public URL required.</>
            : <>Checks GitHub every {Math.round(intervalSeconds / 60)} min while this cockpit is open, through your <code className="text-xs">gh</code>. No webhook or public URL required.</>}
        </p>
      ) : runs.length === 0 ? (
        <p className="m-0 text-[13px] leading-relaxed text-pretty text-muted-foreground">Nothing in the next nine days.</p>
      ) : (
        runs.map((ms) => (
          <div key={ms} data-slot="next-run" className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
            <span className="shrink-0 font-medium whitespace-nowrap text-foreground tabular-nums">
              {dayTime(ms, timeZone)}
            </span>
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{relativeIn(ms, at)}</span>
          </div>
        ))
      )}
    </section>
  )
}
