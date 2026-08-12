import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { NotificationsSection } from './notifications-section'

/**
 * Settings → Notifications (R6 Step 1.7): the toggle's persistence round-trip against a stubbed
 * ui-state API, enable-only permission requests, and the denied/unsupported degradations.
 * The trigger itself (what actually fires) is pinned in components/run-notifications.test.tsx.
 * Since step 3.5 this is a GLOBAL section: every read and write below is asserted against
 * `/api/v1/workspace/ui-state`, and a write to the per-repo `/api/v1/ui-state` would fail the stub's
 * URL match outright.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** GET/PUT the GLOBAL ui-state (`/api/v1/workspace/ui-state`) — the store this section has
 *  written since the step-3.5 settings split; everything else stays honestly pending. */
function serve(uiState: Record<string, unknown> = {}) {
  requests = []
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      return new Promise<never>(() => {})
    }),
  )
}

/** A Notification stand-in with a controllable permission + requestPermission spy. */
function stubNotification(permission: NotificationPermission, answer: NotificationPermission = permission) {
  const requestPermission = vi.fn(async () => {
    ;(FakeNotification as unknown as { permission: string }).permission = answer
    return answer
  })
  function FakeNotification() {}
  ;(FakeNotification as unknown as { permission: string }).permission = permission
  ;(FakeNotification as unknown as { requestPermission: unknown }).requestPermission = requestPermission
  vi.stubGlobal('Notification', FakeNotification)
  return requestPermission
}

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <NotificationsSection />
    </QueryClientProvider>,
  )
}

const toggle = () => screen.getByRole('switch', { name: 'Notify when an agent needs you' })
const putBody = () => requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the notifications section', () => {
  it('is OFF by default — an empty ui-state renders the switch unchecked', async () => {
    serve()
    stubNotification('default')
    renderSection()
    await waitFor(() => expect(requests.some((r) => r.method === 'GET')).toBe(true))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('a persisted true checks the switch at boot — server truth wins', async () => {
    serve({ notifications: { enabled: true } })
    stubNotification('granted')
    renderSection()
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'))
  })

  it('enabling asks for permission (enable only!) and PUTs the additive notifications key', async () => {
    serve()
    const requestPermission = stubNotification('default', 'granted')
    renderSection()

    // Mounting alone must never prompt — that is the "on enable only" contract.
    expect(requestPermission).not.toHaveBeenCalled()

    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(requestPermission).toHaveBeenCalledOnce()
    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: true } }))
  })

  it('enabling with permission already granted does not re-ask', async () => {
    serve()
    const requestPermission = stubNotification('granted')
    renderSection()
    fireEvent.click(toggle())
    expect(requestPermission).not.toHaveBeenCalled()
    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: true } }))
  })

  it('permission denied degrades: the preference still persists and the section says the browser blocks delivery', async () => {
    serve()
    stubNotification('denied')
    renderSection()

    expect(document.querySelector('[data-slot="notifications-denied"]')).toBeNull()
    fireEvent.click(toggle())

    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: true } }))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-slot="notifications-denied"]')?.textContent).toContain(
      'blocking notifications',
    )
  })

  it('a denial GIVEN AT the enable prompt surfaces the same warning', async () => {
    serve()
    stubNotification('default', 'denied')
    renderSection()
    fireEvent.click(toggle())
    await waitFor(() =>
      expect(document.querySelector('[data-slot="notifications-denied"]')).not.toBeNull(),
    )
  })

  it('disabling PUTs enabled:false and never touches the permission API', async () => {
    serve({ notifications: { enabled: true } })
    const requestPermission = stubNotification('granted')
    renderSection()
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(requestPermission).not.toHaveBeenCalled()
    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: false } }))
  })

  it('no Notification API at all: the switch is disabled and the section says so', async () => {
    serve()
    vi.stubGlobal('Notification', undefined)
    renderSection()
    await waitFor(() => expect(requests.some((r) => r.method === 'GET')).toBe(true))
    expect(toggle().hasAttribute('disabled')).toBe(true)
    expect(
      document.querySelector('[data-slot="notifications-unsupported"]')?.textContent,
    ).toContain('does not support')
  })
})
