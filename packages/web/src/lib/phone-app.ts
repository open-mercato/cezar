import type { ProjectsResponse, ProviderStatusResponse } from '@open-mercato/cezar-api-client'

import { bareRootLanding, locationToRestore } from './last-location'
import { hasSignedInAgent } from './onboarding'
import { pathnameProjectId } from './project-router'

/** Manager first on a phone (spec 2026-10-31-mobile-apps-manager-first, Decision 3). */

/** A narrow desktop window has a fine pointer, and an iPad mini's short side is about 744. */
export const isPhone = (): boolean =>
  typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse)').matches &&
  Math.min(screen.width, screen.height) < 600

/** The native shell announces itself in its User-Agent (spec, Decision 2). */
export const isCezarShell = (): boolean => /\bCezarMobile\//.test(navigator.userAgent)

function isInstalled(): boolean {
  const installed = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches
  // iOS home-screen apps report this even where the media query lags behind.
  return installed || (navigator as { standalone?: boolean }).standalone === true
}

/** The shell and a phone PWA only: a browser tab has its own bottom bar. */
export const showsBottomBar = (): boolean => isPhone() && (isCezarShell() || isInstalled())

let firstLocationKey: string | undefined

/** Set at boot and never again, so nothing an in-app link does can make `/` a fresh load. */
export function rememberFirstLocation(key: string): void {
  firstLocationKey ??= key
}

/** A key, not a cleared flag: an effect would clear it after the render a Code link lands in. */
export function isFirstLocation(key: string): boolean {
  return key === firstLocationKey
}

export interface PhoneLandingInput {
  health: { capabilities: { managers?: boolean } } | undefined
  healthFailed: boolean
  registry: ProjectsResponse | undefined
  registryFailed: boolean
  providers: ProviderStatusResponse | undefined
  providersFailed: boolean
  /** The user skipped the sign-in page for good; `undefined` until ui-state answers. */
  agentCheckSkipped: boolean | undefined
  uiStateFailed: boolean
}

/** `FirstRun`'s two obstacle pages, read off the workspace: no agent, and no git project. */
function firstRunFinished(input: PhoneLandingInput): boolean {
  const agentReady = input.agentCheckSkipped === true || hasSignedInAgent(input.providers) === true
  return agentReady && (input.registry?.projects.some((project) => project.status === 'ok') ?? false)
}

/** `restore` is the existing bare-root path, so every unknown ends where a desktop would. */
export function phoneLanding(input: PhoneLandingInput): 'wait' | 'manager' | 'restore' {
  if (input.health === undefined && !input.healthFailed) return 'wait'
  if (input.health?.capabilities.managers !== true) return 'restore'
  if (input.registry === undefined && !input.registryFailed) return 'wait'
  if (input.agentCheckSkipped === undefined && !input.uiStateFailed) return 'wait'
  if (input.agentCheckSkipped !== true && input.providers === undefined && !input.providersFailed) return 'wait'
  return firstRunFinished(input) ? 'manager' : 'restore'
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
    : pathnameProjectId(restored)
  return project === null ? '/' : `/p/${encodeURIComponent(project)}/`
}
