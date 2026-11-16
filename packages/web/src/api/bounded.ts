/** Settles when `send` does, or rejects with `message` after `ms` or when the device goes offline —
 *  even if the transport ignores the abort, so nothing waiting on it can outlive the connection
 *  (relay incident 2026-11-15). */
export function bounded<T>(send: (signal: AbortSignal) => Promise<T>, ms: number, message: string): Promise<T> {
  const controller = new AbortController()
  let fail: (error: Error) => void = () => undefined
  const interrupted = new Promise<never>((_, reject) => { fail = reject })
  const abort = () => {
    fail(new Error(message))
    controller.abort()
  }
  const timer = setTimeout(abort, ms)
  window.addEventListener('offline', abort)
  return Promise.race([send(controller.signal), interrupted]).finally(() => {
    clearTimeout(timer)
    window.removeEventListener('offline', abort)
  })
}
