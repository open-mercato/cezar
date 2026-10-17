/**
 * Compact age — `4s` / `26m` / `2h` / `3d`, the sidebar's and table's age column.
 *
 * One unit, no rounding up, no "ago": at 7px-of-dot density the unit *is* the information. Ports
 * `shortAgo()` from the legacy UI (web/app.js) unchanged, so both cockpits read the same.
 *
 * `now` is a parameter rather than a `Date.now()` call so the tests are not racing the clock.
 * Returns '' for a missing or unparseable timestamp — an empty slot is honest; `NaNm` is not.
 */
export function shortAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  // Clamp: a clock skew between the server's timestamp and the browser must not print `-3s`.
  const seconds = Math.max(0, (now - then) / 1000)
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/**
 * Compact token count — `812` / `96.2k` / `1.4M`. Directional usage supplies the semantic
 * context around this deliberately unit-less number (`IN 96.2k · OUT 1.8k`).
 *
 * Truncates rather than rounds: `999_999` reads `999.9k`, never a `1000.0k` that is really 1M.
 */
export function compactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(Math.floor(tokens / 100_000) / 10).toFixed(1)}M`
  if (tokens >= 1_000) return `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`
  return String(Math.floor(tokens))
}

/**
 * A calendar date the way Mail and Finder print one in a list column: `14:02` today, `Yesterday`,
 * a weekday within the last week, `17 Oct` this year, `17 Oct 2025` before that. Absolute rather
 * than `17d`, so two columns of them (updated, created) read at a glance. Locale-aware; `now` and
 * `locale` are parameters for the tests. '' for a missing or unparseable timestamp.
 */
export function listDate(iso: string | undefined, now: number = Date.now(), locale?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date(now)
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000)
  if (days <= 0) return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString(locale, { weekday: 'short' })
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  }
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}
