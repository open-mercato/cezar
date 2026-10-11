import { lazy, useEffect, type ComponentType, type LazyExoticComponent } from 'react'
import { useLocation } from 'react-router'

import {
  TELEMETRY_ROUTE_SEGMENTS,
  type MessageSurface,
  type TelemetryErrorInput,
} from '@open-mercato/cezar-api-client'

import { useHealth } from '@/api/queries'
import { SID_HEADER, sid } from '@/lib/sid'

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
let lastErrorAt = 0

function reportClientError(
  error: unknown,
  handler: string,
  opts: { code?: string; fingerprint?: string; context?: Context } = {},
): void {
  if (typeof error === 'object' && error !== null) {
    if (reported.has(error)) return
    reported.add(error)
  }
  session.errors += 1
  // Don't flood: at most one cockpit error report per 10 s (the server throttles per error too).
  const now = Date.now()
  if (now - lastErrorAt < 10_000) return
  lastErrorAt = now
  // A thrown non-Error (a string, a bare `window.error` message) has no stack of its own. Never
  // fabricate one: `new Error()` here would record THIS reporter's frame, and every such report
  // would group on the reporter instead of on its message.
  const isError = error instanceof Error
  const err = isError ? error : new Error(String(error))
  const body: TelemetryErrorInput = {
    type: (err.name || 'Error').slice(0, 128),
    message: (err.message || 'unknown error').slice(0, 2048),
    // Stack frames carry the local origin — strip it, the path is enough to group on.
    stack: isError ? err.stack?.split(window.location.origin).join('').slice(0, 16_384) : undefined,
    handler,
    code: opts.code,
    fingerprint: opts.fingerprint,
    context: wideContext(opts.context),
  }
  send('/api/v1/telemetry/error', body)
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
    window.addEventListener('vite:preloadError', (e) =>
      reportClientError((e as Event & { payload?: unknown }).payload, 'vite:preloadError', {
        code: 'chunk_load_failed',
        fingerprint: 'cockpit:chunk_load_failed',
      }),
    )
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
