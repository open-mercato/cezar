import { lazy, useEffect, type ComponentType, type LazyExoticComponent } from 'react'
import { useLocation } from 'react-router'

import {
  attachmentCountBucket,
  TELEMETRY_ROUTE_SEGMENTS,
  type AddProjectDialog,
  type LayoutChange,
  type MessageSurface,
  type SkillsUpdateDropOutcome,
  type TelemetryErrorInput,
  type TerminalOpenSurface,
} from '@open-mercato/cezar-api-client'

import { useHealth, useProjects } from '@/api/queries'
import { onDangerToast } from '@/components/ui/toaster'
import { recentFailedRequest, type FailedRequest } from '@/lib/failed-request'
import { SID_HEADER, sid } from '@/lib/sid'
import { reloadForStaleBuild } from '@/lib/stale-build'

/**
 * Cockpit half of the opt-in telemetry (`packages/cezar/src/telemetry.ts`, docs/telemetry.md). The
 * worker sends no CORS headers, so the browser reports through `/api/v1/telemetry/*`; the server
 * drops everything until the user opted in (`components/telemetry-consent.tsx`). Fire-and-forget: never awaited, never throws.
 *
 * Every error report is ONE wide event (https://loggingsucks.com/): the page, the session, the
 * client and the build it runs, as flat `context` keys — never a bare message. The server relay
 * adds its half (its version, whether this page's bundle is still the one being served).
 */

type ContextValue = string | number | boolean | null
type Context = Record<string, ContextValue>

function send(path: string, body: unknown): void {
  // Unit tests stub `fetch` and count its calls; telemetry must not be one of them (the server
  // drops test-run telemetry too).
  if (import.meta.env.MODE === 'test') return
  try {
    void fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SID_HEADER]: sid() },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // telemetry must never break the app
  }
}

/** A message the user sent to an agent, labelled with where they sent it from. Call it after
 *  the send succeeded, never before — a failed send is not a sent message. */
export function trackMessageSent(surface: Exclude<MessageSurface, 'cli'>): void {
  send('/api/v1/telemetry/event', { event: 'message_sent', label: surface })
}

/** A review comment added on the Changes tab's diff, after it was accepted (a duplicate the
 *  store refuses is not counted). */
export function trackDiffCommentAdded(kind: 'single_line' | 'multi_line'): void {
  send('/api/v1/telemetry/event', { event: 'diff_comment_added', label: kind })
}

/** A sent message carried attachments (telemetry 7054e5f2) — only the count's bucket, after the
 *  send landed. */
export function trackAttachmentsSent(count: number): void {
  if (count < 1) return
  send('/api/v1/telemetry/event', { event: 'attachments_sent', label: attachmentCountBucket(count) })
}

/** A send that hit an expired staged upload, after the automatic re-stage and resend settled. */
export function trackAttachmentsRestaged(outcome: 'recovered' | 'failed'): void {
  send('/api/v1/telemetry/event', { event: 'attachments_restaged', label: outcome })
}

/** One of the "Add project" dialogs was opened (New project, Clone from GitHub, Open local folder). */
export function trackTerminalOpened(surface: TerminalOpenSurface): void {
  send('/api/v1/telemetry/event', { event: 'terminal_opened', label: surface })
}

export function trackTerminalTabRenamed(kind: 'named' | 'reset'): void {
  send('/api/v1/telemetry/event', { event: 'terminal_tab_renamed', label: kind })
}

export function trackLayoutChanged(change: LayoutChange): void {
  send('/api/v1/telemetry/event', { event: 'layout_changed', label: change })
}

export function trackFullViewEntered(screen: 'desktop' | 'narrow'): void {
  send('/api/v1/telemetry/event', { event: 'full_view_toggled', label: screen })
}

export function trackAddProjectOpened(dialog: AddProjectDialog): void {
  send('/api/v1/telemetry/event', { event: 'add_project_opened', label: dialog })
}

/** A skills-update apply got no answer; how following the server's state ended. A `recovered`
 *  drop shows no error, so this is the only signal it happened (telemetry edd8c83e). */
export function trackSkillsUpdateApplyDropped(outcome: SkillsUpdateDropOutcome): void {
  send('/api/v1/telemetry/event', { event: 'skills_update_apply_dropped', label: outcome })
}

/** Whether a pathname is a page the user actually sees. Everything else outside these roots is
 *  a legacy flat URL that redirects into a project (`/` → `/p/<boot>/`) — counting it would put
 *  a phantom step before every real one. */
export function isCanonicalRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/p/') ||
    pathname === '/tasks' ||
    pathname === '/dashboard' ||
    pathname === '/settings/global' ||
    pathname.startsWith('/settings/global/')
  )
}

/** One `page_viewed` per navigation, labelled with the route's shape (see `routeShape`). */
export function trackPage(route: string): void {
  send('/api/v1/telemetry/page', { route })
}

/** Every segment outside the contract's vocabulary — a project slug, a run id, a PR number, a
 *  workflow or skill name — is the user's data and becomes `:param`, so a reported route is the
 *  route's SHAPE and never identifies a project or a task. */
const ROUTE_SEGMENTS = new Set(TELEMETRY_ROUTE_SEGMENTS)

export function routeShape(pathname: string): string {
  const shape = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => (ROUTE_SEGMENTS.has(segment) ? segment : ':param'))
    .join('/')
  return `/${shape}`
}

function engine(ua: string): string {
  if (/Firefox\//.test(ua)) return 'gecko'
  if (/Chrom(e|ium)\/|Edg\//.test(ua)) return 'chromium'
  if (/AppleWebKit\//.test(ua)) return 'webkit'
  return 'other'
}

function os(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macos'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux/.test(ua)) return 'linux'
  return 'other'
}

/** The bundle this page was loaded from — `index-<hash>.js`. This module is statically imported
 *  by the app root, so it rides the entry chunk; the server compares it with what it serves now. */
function entryAsset(): string | null {
  try {
    const file = new URL(import.meta.url).pathname.split('/').pop() ?? ''
    return /^[\w.-]+\.js$/.test(file) ? file : null
  } catch {
    return null
  }
}

/** What the session has done so far — kept current by `<Telemetry />`. */
const session = {
  route: routeShape(typeof window === 'undefined' ? '/' : window.location.pathname),
  previousRoute: null as string | null,
  routeEnteredAt: 0,
  navigations: 0,
  errors: 0,
  serverVersion: null as string | null,
  latestVersion: null as string | null,
}

/** `desktop` inside the Tauri shell, `browser` otherwise. The shell's init script stamps
 *  `window.__CEZ_DESKTOP__` and `<html data-cez-desktop>` on every page it shows (packages/desktop
 *  `INIT_SCRIPT`) — the same flag the title strip reads; Tauri's own IPC global is the fallback
 *  for a shell that predates the stamp. */
export function clientSurface(): 'desktop' | 'browser' {
  if ('__CEZ_DESKTOP__' in window || document.documentElement.dataset.cezDesktop) return 'desktop'
  return '__TAURI_INTERNALS__' in window ? 'desktop' : 'browser'
}

function wideContext(extra: Context = {}): Context {
  const ua = navigator.userAgent
  const now = performance.now()
  return {
    ...extra,
    'page.route': session.route,
    'page.previous_route': session.previousRoute,
    'page.time_on_route_s': Math.round((now - session.routeEnteredAt) / 1000),
    'session.age_s': Math.round(now / 1000),
    'session.navigations': session.navigations,
    'session.errors': session.errors,
    'client.surface': clientSurface(),
    'client.engine': engine(ua),
    'client.os': os(ua),
    'client.online': navigator.onLine,
    'client.visibility': document.visibilityState,
    'client.viewport_w': window.innerWidth,
    'build.entry': entryAsset(),
    'build.server_version_at_load': session.serverVersion,
    'build.update_available':
      session.latestVersion !== null && session.latestVersion !== session.serverVersion,
  }
}

/** Browser notices that arrive as `window.error` but are not failures: the ResizeObserver
 *  "loop" message means a resize callback caused another layout in the same frame, and the
 *  browser deferred the rest to the next one — nothing broke, and every chart and virtualized
 *  list triggers it. Reporting it buries real errors. */
const BENIGN_MESSAGES = [/^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/]

export function isBenignError(message: string): boolean {
  return BENIGN_MESSAGES.some((re) => re.test(message))
}

/** An asset URL as the bundle file alone (`index-<hash>.js`) — never the origin or a query. */
function assetFile(url: string | undefined): string | null {
  if (!url) return null
  const file = url.split(/[?#]/)[0]?.split('/').pop() ?? ''
  return file || null
}

/** Errors already reported, so the window hooks don't report a chunk failure a second time. */
const reported = new WeakSet<object>()
/** Last report per throttle slot: toasts get their own, so a repeated toast never hides a crash. */
const lastErrorAt = { error: 0, toast: 0, staging: 0 }

/** An uncaught `ApiError(0)` — the server never answered — carries its transport cause too. */
function unreachableContext(err: Error): Context {
  return err.name === 'ApiError' && (err as Error & { status?: unknown }).status === 0
    ? transportCauseContext(err.cause)
    : {}
}

function reportClientError(
  error: unknown,
  handler: string,
  opts: { type?: string; code?: string; fingerprint?: string; context?: Context } = {},
): void {
  if (typeof error === 'object' && error !== null) {
    if (reported.has(error)) return
    reported.add(error)
  }
  session.errors += 1
  // Don't flood: at most one cockpit error report per 10 s (the server throttles per error too).
  const now = Date.now()
  // Own slots, so a burst of toasts or staging failures cannot mute a real crash report.
  const slot = handler === 'toast' ? 'toast' : handler === 'attachment-staging' ? 'staging' : 'error'
  if (now - lastErrorAt[slot] < 10_000) return
  lastErrorAt[slot] = now
  // A thrown non-Error (a string, a bare `window.error` message) has no stack of its own. Never
  // fabricate one: `new Error()` here would record THIS reporter's frame, and every such report
  // would group on the reporter instead of on its message.
  const isError = error instanceof Error
  const err = isError ? error : new Error(String(error))
  const body: TelemetryErrorInput = {
    type: (opts.type ?? (err.name || 'Error')).slice(0, 128),
    message: (err.message || 'unknown error').slice(0, 2048),
    // Stack frames carry the local origin — strip it, the path is enough to group on.
    stack: isError ? err.stack?.split(window.location.origin).join('').slice(0, 16_384) : undefined,
    handler,
    code: opts.code,
    fingerprint: opts.fingerprint,
    context: wideContext({ ...unreachableContext(err), ...opts.context }),
  }
  send('/api/v1/telemetry/error', body)
}

/** Static segments of the server's API routes. Anything else — a project slug, a run id, a
 *  workflow or provider name — is the user's data and becomes `:param`, as in `routeShape`. */
const API_SEGMENTS = new Set([
  'api', 'v1', 'agent-profiles', 'apply', 'archive', 'archive-finished', 'association',
  'auto-resume', 'automation-checks', 'automation-log', 'automation-options',
  'automation-templates', 'branch', 'branding-logo', 'cancel', 'candidates', 'channel', 'check',
  'checkout', 'checks', 'comments', 'commit', 'config', 'connect', 'connection', 'consent',
  'continue', 'details', 'diff', 'dispatch', 'drafts', 'enable', 'events', 'feed', 'finish',
  'groups', 'handoff', 'health', 'host-usage', 'images', 'importable', 'launch-key',
  'merge-state', 'messages', 'models', 'nodes', 'open', 'open-in', 'open-in-cli', 'open-targets',
  'parse', 'pause', 'pick', 'pin', 'plan', 'pr', 'providers', 'push', 'queued-messages', 'read',
  'read-all', 'reclaim', 'refresh', 'remove-worktree', 'repo', 'report', 'retry', 'run', 'runs',
  'runs-index', 'search', 'self-update', 'setup', 'skills-update', 'star-count', 'status',
  'telemetry', 'todos', 'tree', 'ui-state', 'unread', 'validate', 'watch', 'workspace', 'ws',
])

/** An API pathname as its route's shape: `/api/v1/p/:param/runs/:param/messages`. */
export function apiRouteShape(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean)
  const shape = segments.map((segment, i) =>
    // The segment after `p` is always a project id, whatever it happens to be called.
    segments[i - 1] === 'p' || !(API_SEGMENTS.has(segment) || ROUTE_SEGMENTS.has(segment))
      ? ':param'
      : segment,
  )
  return `/${shape.join('/')}`.slice(0, 256)
}

/** What a `danger` toast is reported as: an `ApiError` naming the call it came from when a
 *  request failed just before it, else a plain `ErrorToast` (a client-side refusal). */
export function errorToastReport(
  failure: FailedRequest | null,
  now = Date.now(),
): { type: string; context: Context } {
  // No `code`: the panel groups by type + code when one is set, which would merge every 409
  // into one group. Without it a group is the (normalised) message — "session closed".
  if (!failure) return { type: 'ErrorToast', context: {} }
  return {
    type: 'ApiError',
    context: {
      'request.method': failure.method,
      'request.route': apiRouteShape(failure.path),
      'request.status': failure.status,
      'request.age_ms': now - failure.at,
      ...(failure.provider ? { 'request.provider': failure.provider } : {}),
      ...transportCauseContext(failure.cause),
    },
  }
}

/** Which transport failure a status-0 request hit — `TypeError: Load failed` (WebKit, a closed
 *  keep-alive socket), `Failed to fetch` (Chromium), an offline or reset connection (#1437). Fixed
 *  browser strings, still scrubbed and bounded: an engine may quote the URL it could not load. */
export function transportCauseContext(cause: unknown): Context {
  if (typeof cause !== 'object' || cause === null) return {}
  const { name, message } = cause as { name?: unknown; message?: unknown }
  return {
    'request.cause_name': typeof name === 'string' && /^[A-Za-z]\w{0,63}$/.test(name) ? name : 'other',
    'request.cause_message': typeof message === 'string' ? scrubToastMessage(message).slice(0, 256) : '',
  }
}

/** The user's project names and ids, kept current by `Telemetry` for `scrubToastMessage`. */
let knownProjects: string[] = []

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A toast's text without the user's data it interpolates (docs/telemetry.md, "What is never
 *  sent"): quoted values, emails, API URLs (as their route shape), slash-bearing tokens — paths,
 *  branches, `owner/repo` —, the names and ids of the user's projects, and anything after `: `. */
export function scrubToastMessage(message: string, projects: readonly string[] = knownProjects): string {
  let out = message
    .replace(/“[^”]*”|‘[^’]*’|"[^"]*"|`[^`]*`|(?<!\w)'[^'\n]+'(?!\w)/g, '<value>')
    .replace(/[^\s()[\]{}<>,;]+@[^\s()[\]{}<>,;]+\.\w+/g, '<email>')
    .replace(/[^\s()[\]{}<>,;]*\/[^\s()[\]{}<>,;]*/g, (token) => {
      if (!/^(https?:\/\/[^/\s]+)?\/api\//.test(token)) return '<path>'
      try {
        return apiRouteShape(new URL(token, 'http://localhost').pathname)
      } catch {
        return '<path>'
      }
    })
  // Longest first, so `acme-shop` is masked whole before `acme` could match inside it.
  for (const name of [...new Set(projects)].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, 'gi'), '<project>')
  }
  // `label: value` tails — "invalid branch name: x", git/gh stderr — name what the user typed.
  return out.replace(/:\s+\S.*$/s, ': <detail>')
}

/** Every red toast the user saw — "session closed", "cannot reach the cezar server" — is a
 *  failure they hit, so it is reported like an uncaught one, with the call that caused it. */
function reportErrorToast(message: string): void {
  const { type, context } = errorToastReport(recentFailedRequest())
  reportClientError(scrubToastMessage(message), 'toast', { type, context })
}

/** A composer attachment that could not be staged (telemetry 7054e5f2). The send still works —
 *  the bytes ride inline — which is exactly why nobody would notice a broken uploads store
 *  without this report. */
export function reportAttachmentStagingFailed(error: unknown): void {
  const status = (error as { status?: unknown } | null)?.status
  reportClientError(error, 'attachment-staging', {
    code: 'attachment_stage_failed',
    context: { 'request.route': '/api/v1/workspace/uploads', ...(typeof status === 'number' ? { 'request.status': status } : {}) },
  })
}

/** A dictation the browser refused or broke off (telemetry 38ccdbdc, 252d00a6). One fingerprint
 *  for every Web Speech error code — the code rides in context — so `not-allowed` and
 *  `service-not-allowed` stop splitting into separate groups by their toast text. */
export function reportDictationFailed(errorCode: string): void {
  reportClientError(new Error('Dictation failed'), 'toast', {
    type: 'DictationError',
    code: 'dictation_failed',
    fingerprint: 'cockpit:dictation_failed',
    context: {
      'dictation.error': /^[a-z][a-z-]{0,63}$/.test(errorCode) ? errorCode : 'other',
      'dictation.secure_context': window.isSecureContext !== false,
    },
  })
}

/** `React.lazy` that says WHICH page failed when its bundle can't load. Engines word the failure
 *  differently (WebKit: "Importing a module script failed.", Chromium: "Failed to fetch
 *  dynamically imported module") and WebKit sends no stack, so these share one code and one
 *  fingerprint and carry the page in context. The error still reaches React unchanged. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own constraint
export function lazyRoute<T extends ComponentType<any>>(
  name: string,
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    load().catch((error: unknown) => {
      // Stale shell after an update: keep the Suspense fallback up while the page reloads.
      if (reloadForStaleBuild()) return new Promise<never>(() => {})
      reportClientError(error, 'lazy-route', {
        code: 'chunk_load_failed',
        fingerprint: 'cockpit:chunk_load_failed',
        context: { 'chunk.route': name },
      })
      throw error
    }),
  )
}

let handlersInstalled = false

/** Renders nothing: one `page_viewed` per route the user moves to, the session state the error
 *  reports carry, and the window-level error hooks. */
export function Telemetry() {
  const { pathname } = useLocation()
  const health = useHealth()
  const projects = useProjects()

  useEffect(() => {
    knownProjects = (projects.data?.projects ?? []).flatMap((p) => [p.name, p.id])
  }, [projects.data])

  useEffect(() => {
    // The version the page was loaded against: set once, so a later restart shows up as a skew
    // between this and the server's `server.version` on the report.
    if (health.data && session.serverVersion === null) session.serverVersion = health.data.version
    session.latestVersion = health.data?.latestVersion ?? session.latestVersion
  }, [health.data])

  useEffect(() => {
    if (handlersInstalled) return
    handlersInstalled = true
    window.addEventListener('error', (e) => {
      if (isBenignError(e.message ?? '')) return
      // Where the browser says it came from — the only location a stackless error has.
      reportClientError(e.error ?? e.message, 'window.error', {
        context: {
          'error.source_file': assetFile(e.filename),
          'error.line': e.lineno || null,
          'error.col': e.colno || null,
        },
      })
    })
    window.addEventListener('unhandledrejection', (e) =>
      reportClientError(e.reason, 'unhandledrejection'),
    )
    // Vite's own signal that a preloaded dependency of a dynamic import failed to load.
    window.addEventListener('vite:preloadError', (e) => {
      // A reload is the recovery. No preventDefault: that makes Vite resolve the import with
      // `undefined`, and callers expect the rejection (lazyRoute holds its fallback on it).
      if (reloadForStaleBuild()) return
      reportClientError((e as Event & { payload?: unknown }).payload, 'vite:preloadError', {
        code: 'chunk_load_failed',
        fingerprint: 'cockpit:chunk_load_failed',
      })
    })
    onDangerToast(reportErrorToast)
  }, [])

  useEffect(() => {
    if (!isCanonicalRoute(pathname)) return
    const route = routeShape(pathname)
    // The first render counts too (the page the user landed on); a re-render on the same
    // route does not.
    if (route !== session.route || session.navigations === 0) {
      if (session.navigations > 0) session.previousRoute = session.route
      session.route = route
      session.routeEnteredAt = performance.now()
      session.navigations += 1
      trackPage(route)
    }
  }, [pathname])

  return null
}
