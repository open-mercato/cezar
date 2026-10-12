/**
 * The last API request that failed, kept in memory so an error toast can say which call it was
 * about (`lib/telemetry.ts`). Import-free on purpose: `api/client.ts` writes it, and the telemetry
 * module already imports the client.
 */

export interface FailedRequest {
  method: string
  /** The URL's pathname only — the query string never leaves this module. */
  path: string
  /** HTTP status, or 0 when the request never reached the server. */
  status: number
  at: number
}

let last: FailedRequest | null = null

export function noteFailedRequest(url: string, method: string | undefined, status: number): void {
  try {
    const path = new URL(url, window.location.origin).pathname
    last = { method: (method ?? 'GET').toUpperCase(), path, status, at: Date.now() }
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
