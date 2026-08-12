import { useEffect, useRef, useState } from 'react'

import type { RunStatus } from '@open-mercato/cezar-api-client'

/**
 * The audible half of the run's status (audit B6): SSE flips `run.status` visually — the dot,
 * the paused hint, the review panel — but a screen reader hears none of it. This visually-hidden
 * `aria-live` region speaks each TRANSITION ("Agent is waiting for your reply") without ever
 * announcing the initial state: a thread opened on a finished run should read its content, not
 * proclaim "run finished" out of nowhere.
 *
 * `polite` on purpose — status changes never interrupt what the reader is in the middle of.
 */
const STATUS_ANNOUNCEMENTS: Record<RunStatus, string> = {
  queued: 'Run queued, waiting for a free agent slot',
  running: 'Agent is working',
  waiting: 'Agent is waiting for your reply',
  review: 'Changes are ready for review',
  done: 'Run finished',
  failed: 'Run failed',
  cancelled: 'Run cancelled',
}

export function RunStatusAnnouncer({ status }: { status: RunStatus }) {
  const [message, setMessage] = useState('')
  const previous = useRef<RunStatus | null>(null)
  useEffect(() => {
    // First observation is the initial state, not a transition — arm the ref and stay silent.
    if (previous.current !== null && previous.current !== status) {
      setMessage(STATUS_ANNOUNCEMENTS[status])
    }
    previous.current = status
  }, [status])
  return (
    <div data-slot="run-status-announcer" aria-live="polite" role="status" className="sr-only">
      {message}
    </div>
  )
}
