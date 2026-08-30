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
export interface RunEventStreamOptions extends RunEventSubscriptionOptions {
  /** Number of accepted live events retained by this accumulating React adapter. */
  maxEvents?: number
}

let cachedClientBaseUrl: string | undefined
let cachedClient: ReturnType<typeof createCezarClient> | undefined

function currentCockpitClient(): ReturnType<typeof createCezarClient> {
  const baseUrl = getApiBaseUrl()
  if (cachedClient === undefined || cachedClientBaseUrl !== baseUrl) {
    cachedClientBaseUrl = baseUrl
    cachedClient = createCezarClient({ baseUrl })
  }
  return cachedClient
}

export function useRunEvents(
  runId: string | undefined,
  options: RunEventStreamOptions = {},
): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([])
  const { cursor, afterSeq, maxEvents, compactAt, onCompact, onReconnect } = options

  useEffect(() => {
    setEvents([])
    if (!runId) return

    // The parent cockpit installs the legacy transport lease in a layout effect. Resolve the
    // authority here, after that lease is active, while caching one client per authority so a
    // React effect replay does not manufacture a new client identity.
    return currentCockpitClient().forProject(getApiScope()).events.subscribeRun(
      runId,
      { cursor, afterSeq, compactAt, onCompact, onReconnect },
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
