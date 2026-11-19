import type { ProjectsResponse, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

import { bareRootLanding, locationToRestore } from './last-location'
import { pathnameProjectId } from './project-router'

/** Manager first on a phone (spec 2026-10-31-managers, Phones). */

/** A narrow desktop window has a fine pointer, and an iPad mini's short side is about 744. */
export const isPhone = (): boolean =>
  typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse)').matches &&
  Math.min(screen.width, screen.height) < 600

/** The native shell announces itself in its User-Agent (spec 2026-10-31-managers, Phones). */
export const isCezarShell = (): boolean => /\bCezarMobile\//.test(navigator.userAgent)

/** Asks the shell for something by a `cezar://` navigation it cancels; outside the shell, nothing. */
export const shellRequest = {
  open(url: `cezar://${string}`): void {
    if (isCezarShell()) window.location.assign(url)
  },
}

let firstLocationKey: string | undefined

/** Set at boot and never again, so nothing an in-app link does can make `/` a fresh load. */
export function rememberFirstLocation(key: string): void {
  firstLocationKey ??= key
}

/** A key, not a cleared flag: an effect would clear it after the render a Tasks link lands in. */
export function isFirstLocation(key: string): boolean {
  return key === firstLocationKey
}

export interface PhoneLandingInput {
  health: { capabilities: { managers?: boolean } } | undefined
  healthFailed: boolean
  providers: ProviderStatusResponse | undefined
  providersFailed: boolean
}

/** Agent setup lives at the Manager entry; a Git project is not needed to talk to a manager. */
export function phoneLanding(input: PhoneLandingInput): 'wait' | 'manager' | 'restore' {
  if (input.health === undefined && !input.healthFailed) return 'wait'
  if (input.health?.capabilities.managers !== true) return 'restore'
  if (input.providers === undefined && !input.providersFailed) return 'wait'
  if (input.providersFailed && input.providers === undefined) return 'restore'
  return 'manager'
}

/** The bottom bar's Tasks: the last project's index, without restoring the page inside it. */
export function lastProjectIndex(
  remembered: unknown,
  registry: ProjectsResponse | undefined,
  bootProject: string | undefined,
): string {
  const restored = locationToRestore(remembered, registry, bootProject)
  const project = restored === null
    ? (bootProject === undefined ? null : bareRootLanding(registry, bootProject))
    : pathnameProjectId(restored.replace(/[?#].*$/, ''))
  return project === null ? '/' : `/p/${encodeURIComponent(project)}/`
}
