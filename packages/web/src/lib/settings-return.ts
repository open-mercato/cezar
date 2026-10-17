import { isSettingsPathname } from './settings-path'

/**
 * Where the settings frame's `← Back` goes (spec 2026-10-13-unified-settings, "Leaving
 * settings").
 *
 * Settings is full-screen and entered from many places — a sidebar row, the footer gear, ⌘K,
 * a dozen deep links, a cold load — and navigating INSIDE settings pushes history, so
 * `navigate(-1)` would walk back through settings pages one at a time. Instead the router
 * listener (`LastLocationController`) records every NON-settings location here, and Back
 * returns to the last one: the page the user left to open settings, however many settings
 * pages they visited since.
 *
 * Memory-only, on purpose. A reload lands on the frame's fallback (the tasks pane), which is
 * honest: there is nothing to come back to.
 */
export type SettingsReturnLocation = { pathname: string; search: string; hash: string }

let recorded: SettingsReturnLocation | null = null

/** Remember `location` as the way back — a no-op for settings pages themselves. */
export function recordSettingsReturn(location: SettingsReturnLocation): void {
  if (isSettingsPathname(location.pathname)) return
  recorded = { pathname: location.pathname, search: location.search, hash: location.hash }
}

/** The last non-settings location seen, or null when settings was the first page loaded. */
export function settingsReturnLocation(): SettingsReturnLocation | null {
  return recorded
}

/** Test seam: forget the recorded location between cases. */
export function resetSettingsReturn(): void {
  recorded = null
}
