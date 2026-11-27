/** Largest decoded payload an OSC 52 write may put on the clipboard (#2441). */
export const OSC52_MAX_BYTES = 1_000_000

/**
 * Decode an OSC 52 payload (`Pc;Pd`) to text, or null when it must be ignored: a read request
 * (`?` — never answered, so a program cannot read the clipboard), bad base64, or over the cap.
 */
export function decodeOsc52(data: string): string | null {
  const split = data.indexOf(';')
  if (split < 0) return null
  const payload = data.slice(split + 1)
  if (payload === '?' || payload === '') return null
  // Base64 inflates by 4/3; reject before decoding.
  if (payload.length > Math.ceil((OSC52_MAX_BYTES * 4) / 3) + 4) return null
  try {
    const bin = atob(payload)
    if (bin.length > OSC52_MAX_BYTES) return null
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
