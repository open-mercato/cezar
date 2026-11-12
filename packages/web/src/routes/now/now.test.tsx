import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { deriveAttention } from '@/lib/attention'

import { NowRoute, NowView } from './now'

const NOW = Date.parse('2026-11-11T14:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0
function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'quick-task',
    task: `task ${seq}`,
    status: 'done',
    createdAt: ago(3_600_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function LocationProbe() {
  const { pathname, hash } = useLocation()
  return <output data-testid="location">{`${pathname}${hash}`}</output>
}

const PROVIDERS = {
  providers: [{ provider: 'claude', status: 'connected', enabled: true }],
}

function renderNow(props: Partial<ComponentProps<typeof NowView>> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const body = String(input) === '/api/v1/providers/status' ? PROVIDERS : []
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
    }),
  )
  const onArchiveFinished = props.onArchiveFinished ?? vi.fn()
  const onRetry = props.onRetry ?? vi.fn().mockResolvedValue(undefined)
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <LocationProbe />
        <Routes>
          <Route
            path="/p/:projectId/"
            element={<NowView runs={[]} projectName="cezar" now={NOW} {...props} onArchiveFinished={onArchiveFinished} onRetry={onRetry} />}
          />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onArchiveFinished, onRetry }
}

const section = (slot: string) => document.querySelector(`[data-slot="now-${slot}"]`) as HTMLElement
const rowsOf = (slot: string) => [...section(slot).querySelectorAll('[data-slot="now-row"]')].map((row) => row.getAttribute('data-run-id'))
const row = (id: string) => document.querySelector(`[data-slot="now-row"][data-run-id="${id}"]`) as HTMLElement
const location = () => screen.getByTestId('location').textContent

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NowView — the three sections', () => {
  it('splits the index into Needs you, Running and Finished today, in the attention order', () => {
    renderNow({
      runs: [
        run({ id: 'done-today', status: 'done', finishedAt: ago(3_600_000) }),
        run({ id: 'failed', status: 'failed', error: 'checks failed', finishedAt: ago(60_000) }),
        run({ id: 'live', status: 'running', startedAt: ago(120_000) }),
        run({ id: 'review', status: 'review', finishedAt: ago(5_000) }),
        run({ id: 'question', status: 'failed', awaitingAnswerSince: ago(30_000) }),
        run({ id: 'yesterday', status: 'done', finishedAt: ago(40 * 3_600_000) }),
      ],
    })
    expect(rowsOf('needs-you')).toEqual(['question', 'review', 'failed'])
    expect(rowsOf('running')).toEqual(['live'])
    expect(rowsOf('finished-today')).toEqual(['done-today'])
    expect(section('needs-you').getAttribute('data-count')).toBe('3')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Now')
    expect(document.querySelector('[data-slot="now-date"]')?.textContent).toContain('cezar · ')
  })

  it('offers exactly one primary action per reason, each leading where the reason is resolved', () => {
    renderNow({
      runs: [
        run({ id: 'q', status: 'failed', awaitingAnswerSince: ago(30_000) }),
        run({ id: 'rv', status: 'review', diffStat: { adds: 68, dels: 15, files: 3 }, pullRequestUrl: 'https://github.com/o/r/pull/1992', costUsd: 0.83 }),
        run({ id: 'w', status: 'waiting' }),
        run({ id: 'f', status: 'failed', error: 'API Error: cannot reach the API server', steps: [{ id: 's', name: 'Task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0, sessionId: 'sess-1' }] }),
      ],
    })
    const action = (id: string) => row(id).querySelector('[data-slot="now-action"]') as HTMLElement
    expect(action('q').textContent).toBe('Answer')
    expect(action('q').getAttribute('href')).toBe('/p/cezar/tasks/q#ask')
    expect(action('rv').textContent).toBe('Review changes')
    expect(action('rv').getAttribute('href')).toBe('/p/cezar/tasks/rv/changes')
    expect(action('w').textContent).toBe('Reply')
    expect(action('w').getAttribute('href')).toBe('/p/cezar/tasks/w#reply')
    expect(action('f').textContent).toBe('Retry')
    expect(action('f').tagName).toBe('BUTTON')
    // One action each — never a row of buttons.
    for (const id of ['q', 'rv', 'w', 'f']) expect(row(id).querySelectorAll('[data-slot="now-action"]')).toHaveLength(1)
    // The reason line: why, how long, and the facts a reviewer wants.
    const why = (id: string) => row(id).querySelector('[data-slot="now-why"]')?.textContent ?? ''
    expect(why('q')).toContain('Asked a question · 30s')
    expect(why('rv')).toContain('Finished, waiting for review')
    expect(why('rv')).toContain('3 files')
    expect(row('rv').querySelector('[data-slot="diff-stat"]')?.textContent).toBe('+68 −15')
    expect(row('rv').querySelector('[data-slot="pr-chip"]')?.textContent).toContain('1992')
    expect(row('rv').querySelector('[data-slot="now-cost"]')?.textContent).toBe('$0.83')
    expect(why('f')).toContain('API Error: cannot reach the API server')
    expect(row('f').querySelector('[data-slot="now-cost"]')?.textContent).toBe('—')
  })

  it('paints the dot by the attention model: danger for a failure, the person-waiting tone for a question', () => {
    const question = run({ id: 'q', status: 'failed', awaitingAnswerSince: ago(30_000) })
    const failed = run({ id: 'f', status: 'failed' })
    renderNow({ runs: [question, failed] })
    const tone = (id: string) => row(id).querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')
    expect(tone('f')).toBe('danger')
    expect(tone('q')).toBe(deriveAttention(question).tone)
    expect(row('f').className).toContain('border-danger')
    expect(row('q').className).toContain('border-info')
  })

  it('Retry reopens the session through the one delivery seam, and is Open when there is none', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined)
    renderNow({
      onRetry,
      runs: [
        run({ id: 'f', status: 'failed', steps: [{ id: 's', name: 'Task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0, sessionId: 'sess-1' }] }),
        run({ id: 'nosession', status: 'failed' }),
      ],
    })
    const retry = await waitFor(() => {
      const el = row('f').querySelector('[data-action="retry"]') as HTMLButtonElement
      expect(el.disabled).toBe(false)
      return el
    })
    fireEvent.click(retry)
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'f' })))
    const open = row('nosession').querySelector('[data-action="open"]') as HTMLAnchorElement
    expect(open.textContent).toBe('Open')
    expect(open.getAttribute('href')).toBe('/p/cezar/tasks/nosession')
  })

  it('a running row says the workflow and step, carries a progress bar, elapsed and cost', () => {
    renderNow({
      runs: [
        run({
          id: 'live',
          status: 'running',
          workflow: 'implement-and-verify',
          startedAt: ago(12 * 60_000),
          costUsd: 4.1,
          steps: [
            { id: 'a', name: 'Implement', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 },
            { id: 'b', name: 'Verify', kind: 'check', status: 'running', iterations: 1, tokensUsed: 0 },
            { id: 'c', name: 'Review', kind: 'agent', status: 'pending', iterations: 0, tokensUsed: 0 },
          ],
        }),
        run({ id: 'q1', status: 'queued', createdAt: ago(100_000) }),
      ],
    })
    expect(row('live').querySelector('[data-slot="now-why"]')?.textContent).toBe('implement-and-verify · step 2 of 3 · Verify')
    const bar = row('live').querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('50')
    expect(row('live').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('violet')
    expect(row('live').querySelector('[data-slot="now-cost"]')?.textContent).toBe('12m · $4.10')
    expect(row('q1').querySelector('[data-slot="now-why"]')?.textContent).toBe('quick-task · #1 in queue')
    expect(row('q1').querySelector('[role="progressbar"]')).toBeNull()
  })

  it('keeps Finished today calm: neutral dot, capped at eight with the rest on the table, plus the sweep', () => {
    const onArchiveFinished = vi.fn()
    renderNow({
      onArchiveFinished,
      runs: Array.from({ length: 11 }, (_, index) =>
        run({ id: `f${index}`, status: 'done', finishedAt: ago((index + 1) * 60_000), pullRequestUrl: index === 0 ? 'https://github.com/o/r/pull/2016' : undefined }),
      ),
    })
    expect(rowsOf('finished-today')).toHaveLength(8)
    expect(section('finished-today').getAttribute('data-count')).toBe('11')
    expect(row('f0').querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(row('f0').querySelector('[data-slot="pill"]')).toBeNull()
    const more = within(section('finished-today')).getByRole('link', { name: 'Show 3 more' })
    expect(more.getAttribute('href')).toBe('/p/cezar/tasks')
    fireEvent.click(within(section('finished-today')).getByRole('button', { name: /Archive all finished/ }))
    expect(onArchiveFinished).toHaveBeenCalledTimes(1)
  })

  it('says when a section has nothing, and shows the hero when the project has no tasks at all', () => {
    renderNow({ runs: [run({ id: 'done', status: 'done', finishedAt: ago(40 * 3_600_000) })] })
    expect(section('needs-you').querySelector('[data-slot="now-empty"]')?.textContent).toBe('Nothing needs you right now.')
    expect(section('running').querySelector('[data-slot="now-empty"]')?.textContent).toBe('Nothing is running.')
    expect(section('finished-today').querySelector('[data-slot="now-empty"]')?.textContent).toBe('Nothing finished today.')
    cleanup()

    renderNow({ runs: [run({ status: 'done', archived: true })] })
    expect(document.querySelector('[data-slot="now-no-tasks"] [data-slot="centered-state"]')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'No tasks yet' })).toBeTruthy()
    expect(document.querySelector('[data-slot="now-needs-you"]')).toBeNull()
    cleanup()

    // Nothing before the index answers — an empty board would be a lie.
    renderNow({ runs: undefined })
    expect(document.querySelector('[data-slot="now-needs-you"]')).toBeNull()
    expect(document.querySelector('[data-slot="now-no-tasks"]')).toBeNull()
  })

  it('hands the search to the table and links to all tasks inside the project', () => {
    renderNow({ runs: [run({ status: 'running' })] })
    expect(screen.getByRole('link', { name: /All tasks/ }).getAttribute('href')).toBe('/p/cezar/tasks')
    const box = screen.getByRole('searchbox', { name: 'Search tasks' })
    fireEvent.change(box, { target: { value: 'webhook stream' } })
    fireEvent.submit(box.closest('form') as HTMLFormElement)
    expect(location()).toBe('/p/cezar/tasks')
  })
})

describe('NowRoute', () => {
  it('reads the index from /api/v1/runs and names the project from health', async () => {
    const health = {
      version: 't',
      repoRoot: '/r',
      repo: null,
      checks: [],
      defaultRunner: 'claude',
      forge: null,
      capabilities: {},
      projects: [{ id: 'cezar', name: 'cezar' }],
      bootProject: 'cezar',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input)
        const body =
          path.startsWith('/api/v1/runs') ? [run({ id: 'rv', status: 'review', title: 'Needs a look' })]
          : path === '/api/v1/health' ? health
          : path === '/api/v1/providers/status' ? PROVIDERS
          : {}
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/p/cezar/']}>
          <Routes>
            <Route path="/p/:projectId/" element={<NowRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(rowsOf('needs-you')).toEqual(['rv']))
    expect(screen.getByRole('link', { name: 'Needs a look' })).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-slot="now-date"]')?.textContent).toContain('cezar · '))
  })
})
