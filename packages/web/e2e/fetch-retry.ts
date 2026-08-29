/**
 * Setup: retry a failed fetch once when the failure is a stale keep-alive socket.
 *
 * The specs talk to long-lived local servers (the shared env, per-spec fixture serves) through
 * Node's pooled fetch. A socket that sat idle across a slow browser step comes back as
 * ECONNRESET / `fetch failed` on first reuse — a transport artifact, not a server answer, and
 * one retry on a fresh connection is the honest fix. Real failures (refused, 4xx/5xx, DNS)
 * surface exactly as before: only the reset path retries, and only once.
 */
const original = globalThis.fetch

function isStaleSocket(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = (error as { cause?: { code?: string } }).cause
  return cause?.code === 'ECONNRESET' || cause?.code === 'UND_ERR_SOCKET'
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    return await original(input, init)
  } catch (error) {
    if (!isStaleSocket(error)) throw error
    return original(input, init)
  }
}) as typeof fetch
