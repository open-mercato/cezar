import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

import type { TelemetryErrorInput, TelemetryPage, TelemetryPageInput } from '@open-mercato/cezar-api-client'

import { stripProjectPrefix } from './project-router'

/**
 * Cockpit half of the anonymous, opt-out telemetry (`packages/cezar/src/telemetry.ts`). The
 * worker sends no CORS headers, so the browser reports through `/api/v1/telemetry/*`; the server
 * drops everything when `CEZ_TELEMETRY=0`. Fire-and-forget: never awaited, never throws.
 */

function send(path: string, body: unknown): void {
  try {
    void fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // telemetry must never break the app
  }
}

export function trackPage(page: TelemetryPage): void {
  send('/api/v1/telemetry/page', { page } satisfies TelemetryPageInput)
}

/** Which tracked page a pathname is: `/dashboard`, the global `/tasks` (All tasks), and any
 *  settings page — project (`/p/:id/settings…`) or global (`/settings/global…`). Legacy flat
 *  settings URLs redirect onto a scoped one, so only canonical spellings count. */
export function telemetryPageFor(pathname: string): TelemetryPage | undefined {
  if (pathname === '/dashboard') return 'dashboard'
  if (pathname === '/tasks') return 'tasks'
  if (pathname === '/settings/global' || pathname.startsWith('/settings/global/')) return 'settings'
  if (!pathname.startsWith('/p/')) return undefined
  const rest = stripProjectPrefix(pathname)
  if (rest === '/settings' || rest.startsWith('/settings/')) return 'settings'
  return undefined
}

let lastErrorAt = 0

function reportClientError(error: unknown, handler: string): void {
  // Don't flood: at most one cockpit error report per 10 s (the server throttles per error too).
  const now = Date.now()
  if (now - lastErrorAt < 10_000) return
  lastErrorAt = now
  const err = error instanceof Error ? error : new Error(String(error))
  send('/api/v1/telemetry/error', {
    type: (err.name || 'Error').slice(0, 128),
    message: (err.message || 'unknown error').slice(0, 2048),
    // Stack frames carry the local origin — strip it, the path is enough to group on.
    stack: err.stack?.split(window.location.origin).join('').slice(0, 16_384),
    handler,
  } satisfies TelemetryErrorInput)
}

let handlersInstalled = false

/** Renders nothing: one view each time the user enters a tracked page (moving between settings
 *  sections is one visit), plus the window-level error hooks. */
export function Telemetry() {
  const { pathname } = useLocation()
  const last = useRef<TelemetryPage | undefined>(undefined)

  useEffect(() => {
    if (handlersInstalled) return
    handlersInstalled = true
    window.addEventListener('error', (e) => reportClientError(e.error ?? e.message, 'window.error'))
    window.addEventListener('unhandledrejection', (e) =>
      reportClientError(e.reason, 'unhandledrejection'),
    )
  }, [])

  useEffect(() => {
    const page = telemetryPageFor(pathname)
    if (page && page !== last.current) trackPage(page)
    last.current = page
  }, [pathname])

  return null
}
