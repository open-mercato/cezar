import { stripProjectPrefix } from './project-router'

/**
 * Is `pathname` a settings page — in EITHER URL family (spec 2026-10-13-unified-settings)?
 *
 *  - project settings: `/p/<id>/settings` and `/p/<id>/settings/<section>`
 *  - global settings:  `/settings/global` and `/settings/global/<section>`
 *  - the legacy flat `/settings/*` spellings mid-redirect (one frame, then one of the above)
 *
 * The ONE predicate both the app shell (which drops its chrome on a settings page) and the
 * settings frame (which supplies its own) consult, so the two can never disagree about whether
 * a URL is "in settings". Segment-aware: `/settingsfoo` is not a settings page.
 */
export function isSettingsPathname(pathname: string): boolean {
  const flat = stripProjectPrefix(pathname)
  return flat === '/settings' || flat.startsWith('/settings/')
}
