/**
 * The cockpit's one clipboard write. `navigator.clipboard` is undefined outside a secure context
 * (a remote cockpit on plain http over a LAN IP), so a bare `navigator.clipboard.writeText` throws
 * synchronously from the click handler (telemetry `24be63a4`). This never throws: it falls back to
 * a hidden-textarea `execCommand('copy')` and REJECTS when both fail, so callers keep their own
 * "show the text instead" toast in `.catch`.
 */
export async function writeClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return
    } catch (error) {
      if (execCommandCopy(text)) return
      throw error
    }
  }
  // Synchronous before any await, so the legacy path still runs inside the user's click.
  if (execCommandCopy(text)) return
  throw new Error('Clipboard unavailable')
}

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '-9999px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    previous?.focus()
  }
}
