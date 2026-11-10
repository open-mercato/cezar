import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import type { AutomationListEntry, AutomationLogRecord, AutomationLogResponse } from '@open-mercato/cezar-api-client'

import { AutomationLog } from './log'

/**
 * The execution log screen (spec 2026-09-14-automations-redesign § UI/UX 5), driven through a
 * stubbed `fetch` so the rows, tones, children and the retry POST are what the wire says.
 *
 * `automation-change` is played by capturing the workspace-event listener, the same path the
 * live EventSource takes (clone-project-dialog.test.tsx).
 */

let emitWorkspaceEvent: ((name: string, payload: unknown) => void) | null = null

vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: (name: string, payload: unknown) => void) => {
    emitWorkspaceEvent = listener
    return () => {
      emitWorkspaceEvent = null
    }
  },
}))

/** Wednesday, noon UTC: `Wed 04:00` is this morning, six-plus days back turns into a date. */
const NOW = new Date('2026-09-16T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // Radix Select in jsdom: the viewport scrolls the selected item into view on open.
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---- fixtures --------------------------------------------------------------------------------

const AUTOMATION_ID = 'auto-1'

const AUTOMATION = { id: AUTOMATION_ID, name: 'Nightly dependency bump' } as AutomationListEntry

const row = (seq: number, ts: string, result: AutomationLogRecord['result'], rest: Partial<AutomationLogRecord> = {}): AutomationLogRecord => ({
  seq,
  ts,
  automationId: AUTOMATION_ID,
  revision: 1,
  result,
  ...rest,
})

/** The kit's five rows: a dispatching launch, a plain launch, a skip, a failed run, an old one. */
const LOG: AutomationLogResponse = {
  records: [
    row(5, '2026-09-16T04:00:00.000Z', 'launched', { reason: '3 packages bumped · tests green', runId: 't15', receiptId: 'rcpt-5', event: 'issue.opened' }),
    row(4, '2026-09-15T04:00:00.000Z', 'launched', { reason: '1 package bumped', runId: 't11', receiptId: 'rcpt-4', event: 'pull_request.opened' }),
    row(3, '2026-09-14T04:00:00.000Z', 'skipped', { reason: 'nothing outdated — no task created' }),
    row(2, '2026-09-13T04:00:00.000Z', 'failed', { reason: 'npm install exited 1 (ENOTFOUND registry.npmjs.org)', runId: 't13', receiptId: 'rcpt-2' }),
    row(1, '2026-09-01T04:00:00.000Z', 'launched', { reason: '2 packages bumped', runId: 't14' }),
  ],
  runs: {
    t15: {
      title: 'Nightly dependency bump',
      status: 'done',
      costUsd: 0.33,
      children: [
        { runId: 't10', kind: 'implement', title: 'Bump vite 8.1.4 → 8.2.0', status: 'done', costUsd: 0.11 },
        { runId: 't11', title: 'Bump vitest 4.1.10 → 4.2.1', status: 'running', costUsd: 0.09 },
        { runId: 't12', kind: 'review', title: 'Judge the combined branch', status: 'failed' },
      ],
    },
    t11: { title: 'Bump one', status: 'done', costUsd: 0.29, children: [] },
    t13: { title: 'Broken install', status: 'failed', costUsd: 0.04, children: [] },
    t14: { title: 'Old bump', status: 'done', children: [] },
  },
}

interface SentRequest {
  path: string
  method: string
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const LOG_PATH = `/api/v1/automation-log?automationId=${AUTOMATION_ID}`

/** Records requests and serves the log; `overrides` are keyed `METHOD path`. */
function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}, log: AutomationLogResponse = LOG): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === LOG_PATH) return jsonResponse(log)
      if (method === 'GET' && path === '/api/v1/health') {
        return jsonResponse({ version: '0.0.0-test', repoRoot: '/repo', repo: { root: '/repo', branch: 'main' }, forge: null, capabilities: { automations: true }, defaultRunner: 'claude', checks: [] })
      }
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderLog(props: Partial<Parameters<typeof AutomationLog>[0]> = {}) {
  const onBack = vi.fn()
  const utils = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/automations/${AUTOMATION_ID}/log`]}>
        <AutomationLog automationId={AUTOMATION_ID} automation={AUTOMATION} timeZone="UTC" onBack={onBack} {...props} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...utils, onBack }
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="log-row"]'))
const awaitRows = async (count: number) => {
  await waitFor(() => expect(rows()).toHaveLength(count))
  return rows()
}
const pillTone = (el: HTMLElement) => el.querySelector('[data-slot="pill"] [data-slot="status-dot"]')?.getAttribute('data-tone')
const cell = (el: HTMLElement, index: number) => (el.children[index] as HTMLElement | undefined)?.textContent

/** Open a Radix Select by keyboard (jsdom has no real pointer) and choose an option. */
async function pick(triggerName: string, option: string) {
  fireEvent.keyDown(screen.getByRole('combobox', { name: triggerName }), { key: 'ArrowDown' })
  const item = await screen.findByRole('option', { name: option })
  fireEvent.click(item)
}

// ---- tests -----------------------------------------------------------------------------------

describe('AutomationLog', () => {
  it('renders the header: back, name, the log suffix, filters and Edit', async () => {
    stubFetch()
    const { onBack } = renderLog()
    await awaitRows(5)

    const screenEl = document.querySelector('[data-slot="automation-log"]')
    expect(screenEl).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Nightly dependency bump')
    expect(screen.getByText('· execution log')).not.toBeNull()
    expect(screen.getByRole('combobox', { name: 'Filter by result' }).textContent).toContain('All results')
    expect(screen.getByRole('combobox', { name: 'Filter by event' }).textContent).toContain('All events')
    expect(screen.getByRole('button', { name: 'Edit' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('falls back to "Automation" while the list entry is not known yet', async () => {
    stubFetch()
    renderLog({ automation: undefined })
    await awaitRows(5)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Automation')
  })

  it('tints each row by result: launched → success, skipped → neutral, failed → danger', async () => {
    stubFetch()
    renderLog()
    const [launched, , skipped, failed] = await awaitRows(5)

    expect(pillTone(launched!)).toBe('success')
    expect(cell(launched!, 1)).toBe('launched')
    expect(pillTone(skipped!)).toBe('neutral')
    expect(cell(skipped!, 1)).toBe('skipped')
    expect(pillTone(failed!)).toBe('danger')
    expect(cell(failed!, 1)).toBe('failed')

    // The note is the reason; only a danger row paints it red.
    const failedNote = failed!.children[2] as HTMLElement
    expect(failedNote.textContent).toBe('npm install exited 1 (ENOTFOUND registry.npmjs.org)')
    expect(failedNote.className).toContain('text-danger')
    expect((launched!.children[2] as HTMLElement).className).not.toContain('text-danger')
  })

  it('stamps rows via logTime in the server zone: weekday inside six days, a date beyond', async () => {
    stubFetch()
    renderLog({ timeZone: 'Europe/Warsaw' })
    const [first, , , , old] = await awaitRows(5)
    // 04:00Z is 06:00 in Warsaw (CEST) — the SERVER's zone, never the browser's.
    expect(cell(first!, 0)).toBe('Wed 06:00')
    expect(cell(old!, 0)).toBe('1 Sep 06:00')
  })

  it('defaults to UTC when the server has not said its zone', async () => {
    stubFetch()
    renderLog({ timeZone: undefined })
    const [first] = await awaitRows(5)
    expect(cell(first!, 0)).toBe('Wed 04:00')
  })

  it('shows no cost cell while AUTOMATION_COST_VISIBLE is off', async () => {
    stubFetch()
    renderLog()
    const [first, , skipped] = await awaitRows(5)
    expect(first!.textContent).not.toContain('$0.33')
    expect(cell(first!, 3)).toContain('Open task')
    expect(cell(skipped!, 3) ?? '').not.toBe('—')
  })

  it('links "Open task" to /tasks/<runId> on rows with a run, and leaves an empty cell otherwise', async () => {
    stubFetch()
    renderLog()
    const [first, , skipped] = await awaitRows(5)
    const link = within(first!).getByRole('link', { name: /Open task/ })
    expect(link.getAttribute('href')).toBe('/tasks/t15')
    expect(within(skipped!).queryByRole('link')).toBeNull()
    expect(within(skipped!).queryByRole('button')).toBeNull()
    expect(skipped!.children).toHaveLength(4)
  })

  it('lists dispatch children under their row: kind pill, status dot, title and Open (cost hidden for now)', async () => {
    stubFetch()
    renderLog()
    const [first, second] = await awaitRows(5)

    const children = Array.from(first!.querySelectorAll<HTMLElement>('[data-slot="log-child"]'))
    expect(children).toHaveLength(3)
    expect(second!.querySelectorAll('[data-slot="log-child"]')).toHaveLength(0)

    const [vite, vitest, judge] = children
    expect(cell(vite!, 0)).toBe('└')
    expect(cell(vite!, 1)).toBe('implement')
    expect(vite!.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(cell(vite!, 2)).toBe('Bump vite 8.1.4 → 8.2.0')
    expect(vite!.textContent).not.toContain('$0.11')
    expect(within(vite!).getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/tasks/t10')

    // A child without a kind reads as implement; a running one pulses pending.
    expect(cell(vitest!, 1)).toBe('implement')
    expect(vitest!.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('pending')
    expect(cell(judge!, 1)).toBe('review')
    expect(judge!.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(within(judge!).getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/tasks/t12')
  })

  it('offers "Retry task" only on a failed row with a receipt and no run, and POSTs the retry route', async () => {
    const launchError = row(6, '2026-09-16T05:00:00.000Z', 'failed', { reason: 'spawn ENOENT', receiptId: 'rcpt-9' })
    const log: AutomationLogResponse = { ...LOG, records: [launchError, ...LOG.records] }
    const sent = stubFetch({
      [`POST /api/v1/automation-log/rcpt-9/retry`]: () => jsonResponse({ receiptId: 'rcpt-9', runId: 't99' }, 202),
    }, log)
    renderLog()
    const [stuck, , , , failedWithRun] = await awaitRows(6)

    expect(within(stuck!).queryByRole('link')).toBeNull()
    // A failed row that DID get a run links to it and cannot be retried.
    expect(within(failedWithRun!).getByRole('link', { name: /Open task/ }).getAttribute('href')).toBe('/tasks/t13')
    expect(within(failedWithRun!).queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Retry task' })).toHaveLength(1)

    fireEvent.click(within(stuck!).getByRole('button', { name: 'Retry task' }))
    await waitFor(() => expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/automation-log/rcpt-9/retry')).toBe(true))
    // The success refetches the log.
    await waitFor(() => expect(sent.filter((r) => r.method === 'GET' && r.path === LOG_PATH).length).toBeGreaterThanOrEqual(2))
  })

  it('toasts the server\'s reason when the retry is refused', async () => {
    const launchError = row(6, '2026-09-16T05:00:00.000Z', 'failed', { reason: 'spawn ENOENT', receiptId: 'rcpt-9' })
    stubFetch({
      [`POST /api/v1/automation-log/rcpt-9/retry`]: () => jsonResponse({ error: 'automation polling lease is held by another process' }, 409),
    }, { ...LOG, records: [launchError] })
    renderLog()
    const [stuck] = await awaitRows(1)
    fireEvent.click(within(stuck!).getByRole('button', { name: 'Retry task' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('automation polling lease is held by another process'))
  })

  it('shows the empty state when no checks have run', async () => {
    stubFetch({}, { records: [], runs: {} })
    renderLog()
    await screen.findByText('No checks have run yet.')
    expect(rows()).toHaveLength(0)
  })

  it('shows the server\'s error message when the log cannot be read', async () => {
    // A 4xx is the server's considered answer and is never retried (query-client.ts), so the
    // message lands at once; a 5xx would be retried once first.
    stubFetch({ [`GET ${LOG_PATH}`]: () => jsonResponse({ error: 'automation store unreadable' }, 409) })
    renderLog()
    await screen.findByText('automation store unreadable')
  })

  it('shows a loading state before the log answers', () => {
    stubFetch({ [`GET ${LOG_PATH}`]: () => new Promise<Response>(() => undefined) })
    renderLog()
    expect(screen.getByText('Loading execution log…')).not.toBeNull()
  })

  it('narrows the rows by result and by event, without a second request', async () => {
    const sent = stubFetch()
    renderLog()
    await awaitRows(5)

    await pick('Filter by result', 'launched')
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(rows().every((r) => r.getAttribute('data-result') === 'launched')).toBe(true)

    await pick('Filter by event', 'issue.opened')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.getAttribute('data-result')).toBe('launched')
    expect(cell(rows()[0]!, 2)).toBe('3 packages bumped · tests green')

    await pick('Filter by result', 'All results')
    await pick('Filter by event', 'All events')
    await waitFor(() => expect(rows()).toHaveLength(5))
    expect(sent.filter((r) => r.method === 'GET' && r.path === LOG_PATH)).toHaveLength(1)
  })

  it('refetches on a matching automation-change event and ignores the others', async () => {
    const sent = stubFetch()
    renderLog()
    await awaitRows(5)
    const gets = () => sent.filter((r) => r.method === 'GET' && r.path === LOG_PATH).length
    expect(gets()).toBe(1)

    act(() => emitWorkspaceEvent?.('automation-change', { project: 'p1', automationId: 'someone-else', revision: 2 }))
    act(() => emitWorkspaceEvent?.('project-added', { project: 'p1' }))
    expect(gets()).toBe(1)

    act(() => emitWorkspaceEvent?.('automation-change', { project: 'p1', automationId: AUTOMATION_ID, revision: 2 }))
    await waitFor(() => expect(gets()).toBe(2))
  })
})
