import { useEffect, useRef } from 'react'

import { hasAutoSwitched, markAutoSwitched } from './impact-model'

/**
 * Switch to Assets ONCE when an impact run's report APPEARS while its task is open (spec
 * 2026-10-22-html-artifacts-and-impact § "The moment an artifact appears"). Only a transition seen
 * on this mount counts — opening a task whose report already exists stays where the user went —
 * and the run is remembered for the session, so leaving Assets never bounces the user back.
 */
export function useImpactAutoSwitch(
  run: { id: string; subject?: unknown },
  /** `undefined` while the listing is still loading. */
  hasImpact: boolean | undefined,
  onSwitch: () => void,
): void {
  const seen = useRef<{ runId: string; without: boolean; fired: boolean }>({ runId: run.id, without: false, fired: false })
  if (seen.current.runId !== run.id) seen.current = { runId: run.id, without: false, fired: false }
  const subject = run.subject !== undefined
  const latest = useRef(onSwitch)
  latest.current = onSwitch

  useEffect(() => {
    if (!subject || hasImpact === undefined) return
    const state = seen.current
    if (!hasImpact) {
      state.without = true
      return
    }
    if (!state.without || state.fired || hasAutoSwitched(run.id)) return
    state.fired = true
    markAutoSwitched(run.id)
    latest.current()
  }, [hasImpact, run.id, subject])
}
