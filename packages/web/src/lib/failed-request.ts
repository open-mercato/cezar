/**
 * The last API request that failed, kept in memory so an error toast can say which call it was
 * about (`lib/telemetry.ts`). Import-free on purpose: `api/client.ts` writes it, and the telemetry
 * module already imports the client.
 */

import { providerIdSchema } from '@open-mercato/cezar-api-client'

export interface FailedRequest {
  method: string
  /** The URL's pathname only — the query string never leaves this module. */
  path: string
  /** HTTP status, or 0 when the request never reached the server. */
  status: number
  at: number
  /** Which agent a `/providers` or `/agent-profiles` call was about — a closed set, from the path
   *  or the JSON body. Its route shape alone hides it (telemetry `abf08514`). */
  provider?: string
  /** Why a status-0 request got no answer: the browser's own rejection (`TypeError: Load failed`).
   *  Raw here; telemetry scrubs and bounds it before it leaves the page (#1437). */
  cause?: { name: string; message: string }
}

function causeOf(cause: unknown): FailedRequest['cause'] {
  if (typeof cause !== 'object' || cause === null) return undefined
  const { name, message } = cause as { name?: unknown; message?: unknown }
  return { name: typeof name === 'string' ? name : 'unknown', message: typeof message === 'string' ? message : '' }
}

const PROVIDER_ROUTE = /\/(?:providers|agent-profiles)(?:\/|$)/

function providerOf(path: string, body: unknown): string | undefined {
  if (!PROVIDER_ROUTE.test(path)) return undefined
  const segments = path.split('/')
  const fromPath = segments[segments.indexOf('providers') + 1]
  if (segments.includes('providers') && providerIdSchema.safeParse(fromPath).success) return fromPath
  if (typeof body !== 'string') return undefined
  try {
    const candidate = (JSON.parse(body) as { provider?: unknown }).provider
    return providerIdSchema.safeParse(candidate).success ? (candidate as string) : undefined
  } catch {
    return undefined
  }
}

let last: FailedRequest | null = null

export function noteFailedRequest(
  url: string,
  method: string | undefined,
  status: number,
  body?: unknown,
  cause?: unknown,
): void {
  try {
    const path = new URL(url, window.location.origin).pathname
    const provider = providerOf(path, body)
    const transport = causeOf(cause)
    last = {
      method: (method ?? 'GET').toUpperCase(),
      path,
      status,
      at: Date.now(),
      ...(provider ? { provider } : {}),
      ...(transport ? { cause: transport } : {}),
    }
  } catch {
    // never break a request over bookkeeping
  }
}

/** The failure that most likely produced a toast shown now: a toast follows its request within
 *  the same tick or a render later, so anything older belongs to something else. */
export function recentFailedRequest(withinMs = 3000, now = Date.now()): FailedRequest | null {
  return last && now - last.at <= withinMs ? last : null
}

/** Test seam. */
export function resetFailedRequest(): void {
  last = null
}
