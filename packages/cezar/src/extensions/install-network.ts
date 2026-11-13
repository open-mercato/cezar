import { open, rm } from 'node:fs/promises'
import { limitsError } from './install-files.ts'

export class RegistryResponseError extends Error {
  constructor(readonly status: number) { super(`could not download extension dependency (${status})`) }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/** Download one registry artifact without following a redirect off the configured registry. */
export async function downloadRegistryArtifact(url: string, origin: string, destination: string, maxBytes: number, signal?: AbortSignal, accept?: string): Promise<void> {
  let current = url
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(current)
    if (parsed.origin !== origin || parsed.username || parsed.password) throw new Error('extension dependency redirect leaves the configured registry')
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(current, { redirect: 'manual', signal: controller.signal, ...(accept ? { headers: { accept } } : {}) })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) {
          await cancelResponseBody(response)
          throw new Error('extension dependency redirect has no location')
        }
        await cancelResponseBody(response)
        current = new URL(location, current).toString()
        continue
      }
      if (!response.ok || !response.body) {
        await cancelResponseBody(response)
        throw new RegistryResponseError(response.status)
      }
      const advertised = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(advertised) && advertised > maxBytes) {
        await cancelResponseBody(response)
        throw limitsError()
      }
      const reader = response.body.getReader()
      let bytes = 0
      const file = await open(destination, 'wx', 0o600).catch(async error => {
        await reader.cancel().catch(() => undefined); reader.releaseLock(); throw error
      })
      let complete = false
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > maxBytes) throw limitsError()
          await file.writeFile(next.value)
        }
        complete = true
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        throw error
      } finally {
        reader.releaseLock()
        await file.close()
        if (!complete) await rm(destination, { force: true })
      }
      return
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }
  throw new Error('extension dependency has too many redirects')
}

