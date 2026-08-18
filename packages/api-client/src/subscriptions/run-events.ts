import type { RunEvent } from '@open-mercato/cezar-contract'
import { projectApiPath, resolveCezarUrl } from '../utils/urls.ts'

export const RUN_EVENT_NAMES = ['run-event', 'ui-event'] as const

export interface CezarEventSource {
  readonly readyState: number
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  close(): void
}

export type CezarEventSourceFactory = (
  url: string,
  init?: EventSourceInit,
) => CezarEventSource

export interface RunEventSubscriptionOptions {
  cursor?: string
  afterSeq?: number
  /** Number of accepted live events retained by an accumulating adapter. */
  maxEvents?: number
  /** Ask the history owner to fold the live prefix into a persisted tail page. */
  compactAt?: number
  onCompact?: () => void
  /** Runs only after a replacement connection has opened, never on the initial open. */
  onReconnect?: () => void
}

export interface CezarProjectEventDomain {
  subscribeRun(
    runId: string,
    options: RunEventSubscriptionOptions,
    listener: (event: RunEvent) => void,
  ): () => void
}

export interface CezarEventDomain {
  forProject(projectId?: string | null): CezarProjectEventDomain
}

/** Parse one SSE frame without letting one malformed line terminate the stream. */
export function parseRunEvent(data: string): RunEvent | null {
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const { seq, type } = payload as { seq?: unknown; type?: unknown }
  if (typeof seq !== 'number' || typeof type !== 'string' || type === '') return null
  return payload as RunEvent
}

function resolveEventSourceFactory(
  configured: CezarEventSourceFactory | undefined,
): CezarEventSourceFactory | undefined {
  if (configured) return configured
  const Source = globalThis.EventSource
  if (typeof Source !== 'function') return undefined
  return (url, init) => new Source(url, init)
}

function eventUrl(
  baseUrl: string,
  projectId: string | null,
  runId: string,
  cursor: string | undefined,
  maxSeq: number,
  resume: boolean,
): string {
  const params = new URLSearchParams()
  if (cursor !== undefined) params.set('cursor', cursor)
  if (resume) params.set('afterSeq', String(maxSeq))
  const query = params.size === 0 ? '' : `?${params.toString()}`
  const path = projectApiPath(
    projectId,
    `/runs/${encodeURIComponent(runId)}/events${query}`,
  )
  return resolveCezarUrl(baseUrl, path)
}

export function createCezarProjectEventDomain(
  baseUrl: string,
  projectId: string | null,
  configuredEventSource?: CezarEventSourceFactory,
): CezarProjectEventDomain {
  return {
    subscribeRun(runId, options, listener) {
      const createSource = resolveEventSourceFactory(configuredEventSource)
      if (!createSource) return () => {}

      const {
        cursor,
        afterSeq = 0,
        maxEvents,
        compactAt,
        onCompact,
        onReconnect,
      } = options
      const doc = typeof globalThis.document === 'undefined' ? undefined : globalThis.document
      const win = typeof globalThis.window === 'undefined' ? undefined : globalThis.window
      const CLOSED = 2
      const REOPEN_DELAY_MS = 1_500
      const STALE_MS = 40_000
      const LIVENESS_CHECK_MS = 10_000
      const resumeWithHighWater = cursor !== undefined || afterSeq > 0

      let maxSeq = afterSeq
      let sourceCount = 0
      let binding: { source: CezarEventSource; detach: () => void } | undefined
      let reopenTimer: ReturnType<typeof globalThis.setTimeout> | undefined
      let disposed = false
      let compactionRequested = false
      let acceptedEvents = 0
      let lastFrameAt = Date.now()

      const closeCurrent = (): void => {
        if (!binding) return
        const current = binding
        binding = undefined
        current.detach()
        current.source.close()
      }

      const onFrame = (event: Event): void => {
        lastFrameAt = Date.now()
        const parsed = parseRunEvent((event as MessageEvent<string>).data)
        if (disposed || !parsed || !(parsed.seq > maxSeq)) return
        maxSeq = parsed.seq
        acceptedEvents = maxEvents === undefined
          ? acceptedEvents + 1
          : Math.min(acceptedEvents + 1, Math.max(0, maxEvents))
        listener(parsed)
        if (!compactionRequested && compactAt !== undefined && acceptedEvents >= compactAt) {
          compactionRequested = true
          queueMicrotask(() => {
            if (!disposed) onCompact?.()
          })
        }
      }

      const onPing = (): void => {
        lastFrameAt = Date.now()
      }

      const open = (): void => {
        if (disposed) return
        closeCurrent()
        lastFrameAt = Date.now()
        sourceCount += 1
        const replacement = sourceCount > 1
        const source = createSource(
          eventUrl(baseUrl, projectId, runId, cursor, maxSeq, resumeWithHighWater),
          { withCredentials: true },
        )
        let opened = false
        const onOpen = (): void => {
          if (disposed) return
          if (replacement || opened) onReconnect?.()
          opened = true
        }
        const onError = (): void => {
          if (disposed || source.readyState !== CLOSED || reopenTimer !== undefined) return
          reopenTimer = globalThis.setTimeout(() => {
            reopenTimer = undefined
            open()
          }, REOPEN_DELAY_MS)
        }
        for (const name of RUN_EVENT_NAMES) source.addEventListener(name, onFrame)
        source.addEventListener('ping', onPing)
        source.addEventListener('open', onOpen)
        source.addEventListener('error', onError)
        binding = {
          source,
          detach: () => {
            for (const name of RUN_EVENT_NAMES) source.removeEventListener(name, onFrame)
            source.removeEventListener('ping', onPing)
            source.removeEventListener('open', onOpen)
            source.removeEventListener('error', onError)
          },
        }
      }

      const reopenNow = (): void => {
        globalThis.clearTimeout(reopenTimer)
        reopenTimer = undefined
        open()
      }
      const onVisibilityChange = (): void => {
        if (doc?.visibilityState !== 'visible') return
        if (!binding || binding.source.readyState === CLOSED) reopenNow()
      }
      const onPageHide = (): void => {
        globalThis.clearTimeout(reopenTimer)
        reopenTimer = undefined
        closeCurrent()
      }
      const onPageShow = (event: Event): void => {
        if ((event as PageTransitionEvent).persisted) reopenNow()
      }
      const livenessTimer = doc === undefined
        ? undefined
        : globalThis.setInterval(() => {
            if (disposed || doc.visibilityState !== 'visible') return
            if (Date.now() - lastFrameAt <= STALE_MS) return
            reopenNow()
          }, LIVENESS_CHECK_MS)

      doc?.addEventListener('visibilitychange', onVisibilityChange)
      win?.addEventListener('pagehide', onPageHide)
      win?.addEventListener('pageshow', onPageShow)
      open()

      return () => {
        if (disposed) return
        disposed = true
        globalThis.clearTimeout(reopenTimer)
        globalThis.clearInterval(livenessTimer)
        doc?.removeEventListener('visibilitychange', onVisibilityChange)
        win?.removeEventListener('pagehide', onPageHide)
        win?.removeEventListener('pageshow', onPageShow)
        closeCurrent()
      }
    },
  }
}
