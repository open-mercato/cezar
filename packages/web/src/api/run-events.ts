import { useEffect, useState } from 'react'

import {
  createCezarClient,
  getApiBaseUrl,
  getApiScope,
  type RunEvent,
  type RunEventSubscriptionOptions,
} from '@open-mercato/cezar-api-client'

export { parseRunEvent, RUN_EVENT_NAMES } from '@open-mercato/cezar-api-client'

/**
 * Private React compatibility adapter for callers that still consume a list of raw run events.
 * Socket ownership, parsing, replay deduplication, and recovery live in the public API client;
 * this hook only selects the cockpit's current project and accumulates accepted events as state.
 */
export interface RunEventStreamOptions extends RunEventSubscriptionOptions {}

export function useRunEvents(
  runId: string | undefined,
  options: RunEventStreamOptions = {},
): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])
  const { cursor, afterSeq, maxEvents, compactAt, onCompact, onReconnect } = options

  useEffect(() => {
    setEvents([])
    if (!runId) return

    // Runtime API-base configuration happens after module import. Constructing this private
    // adapter client here captures the current value while EventSource itself remains lazily
    // resolved by subscribeRun, preserving prerender/non-DOM safety.
    const cockpitClient = createCezarClient({ baseUrl: getApiBaseUrl() })
    return cockpitClient.forProject(getApiScope()).events.subscribeRun(
      runId,
      { cursor, afterSeq, maxEvents, compactAt, onCompact, onReconnect },
      (event) => {
        setEvents((current) => {
          const next = [...current, event]
          return maxEvents === undefined || next.length <= maxEvents
            ? next
            : next.slice(-maxEvents)
        })
      },
    )
  }, [runId, cursor, afterSeq, maxEvents, compactAt, onCompact, onReconnect])

  return events
}
