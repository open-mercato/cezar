/**
 * This browser profile's (or desktop window's) device id: a UUIDv7, created once and kept in
 * localStorage under a short neutral key. The server pairs it with the machine's `cezarId` as
 * telemetry's `<cezarId>:<sid>`, so each device is counted on its own and dated by its id.
 */

const SID_KEY = 'cezar:sid'
let memorySid: string | undefined

/** RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, then random bits. */
export function uuidv7(now: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function sid(): string {
  try {
    const stored = localStorage.getItem(SID_KEY)
    if (stored) return stored
    const id = uuidv7()
    localStorage.setItem(SID_KEY, id)
    return id
  } catch {
    // Storage blocked (private mode, a sandboxed frame): one id for this page's lifetime.
    return (memorySid ??= uuidv7())
  }
}

/** The request header the server reads it from. */
export const SID_HEADER = 'x-cezar-sid'

/** Forget this browser's device id — telemetry consent was withdrawn, so a later yes starts
 *  as a new device rather than reconnecting to the old one. */
export function resetSid(): void {
  memorySid = undefined
  try {
    localStorage.removeItem(SID_KEY)
  } catch {
    // nothing stored, nothing to forget
  }
}
