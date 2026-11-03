import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import type { ApiRun, ArtifactsBySubjectResponse, RunArtifact } from '@open-mercato/cezar-api-client'

import { ImpactControl } from './impact-control'
import { impactMeta, impactState, isSpecPath } from './impact-model'

const NOW = Date.parse('2026-10-23T12:00:00.000Z')
const IMPACT: RunArtifact = { name: 'impact.html', kind: 'html', size: 10, updatedAt: '2026-10-23T10:00:00.000Z' }
const NONE: ArtifactsBySubjectResponse = { run: null, subject: null, artifacts: [], truncated: false, stale: null }

function found(over: Partial<Extract<ArtifactsBySubjectResponse, { run: object }>> = {}): ArtifactsBySubjectResponse {
  return {
    run: { id: 'r9', status: 'done', title: 'Assess #12', createdAt: '2026-10-23T09:00:00.000Z' },
    subject: { kind: 'pr', number: 12, headSha: 'abcdef1234567890' },
    artifacts: [IMPACT],
    truncated: false,
    stale: false,
    ...over,
  }
}

let answer: ArtifactsBySubjectResponse
let runs: Partial<ApiRun>[]
let post: { status: number; body: unknown }
const posted: unknown[] = []

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  answer = NONE
  runs = []
  post = { status: 201, body: { runId: 'r10' } }
  posted.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      if (path.includes('/artifacts?subject=')) return json(answer)
      if (path.endsWith('/impact') && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return json(post.body, post.status)
      }
      if (path.endsWith('/api/v1/runs')) return json(runs)
      return json({ error: `unstubbed ${path}` }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function mount(unavailable?: string) {
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/github/prs/12']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ImpactControl subject={{ kind: 'pr', number: 12 }} unavailable={unavailable} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const control = () => document.querySelector('[data-slot="impact-control"]')
const stateOf = async (state: string) => waitFor(() => expect(control()?.getAttribute('data-state')).toBe(state))

describe('isSpecPath', () => {
  it('matches .ai/specs/**/*.md only', () => {
    expect(isSpecPath('.ai/specs/2026-10-22-html-artifacts-and-impact.md')).toBe(true)
    expect(isSpecPath('.ai/specs/archive/old/x.md')).toBe(true)
    expect(isSpecPath('.ai/specs/notes.txt')).toBe(false)
    expect(isSpecPath('.ai/specs/')).toBe(false)
    expect(isSpecPath('docs/.ai/specs/x.md')).toBe(false)
    expect(isSpecPath('.ai/specs/../README.md')).toBe(false)
    expect(isSpecPath('.ai/specs//x.md')).toBe(false)
    expect(isSpecPath('README.md')).toBe(false)
    expect(isSpecPath(null)).toBe(false)
  })
})

describe('impactState / impactMeta', () => {
  it('reads a live status over the answer, and says why a finished run has no report', () => {
    expect(impactState(found({ artifacts: [] }), { pending: false, liveStatus: 'running' }).kind).toBe('assessing')
    expect(impactState(found({ artifacts: [] }), { pending: false, liveStatus: 'waiting' }).kind).toBe('assessing')
    // A rendered report stays openable while the session lives on (parked, or revising — R4).
    expect(impactState(found(), { pending: false, liveStatus: 'waiting' }).kind).toBe('open')
    expect(impactState(found({ artifacts: [] }), { pending: false })).toMatchObject({ kind: 'assess', runId: 'r9' })
    expect(impactState(found({ artifacts: [], run: { id: 'r9', status: 'failed', title: '', createdAt: '' } }), { pending: false }))
      .toMatchObject({ kind: 'assess', note: expect.stringMatching(/failed/) })
    expect(impactState(undefined, { pending: true }).kind).toBe('loading')
  })

  it('meta is sha7 · age · vN, the version only once one was kept', () => {
    expect(impactMeta('abcdef1234', IMPACT.updatedAt, undefined, NOW)).toBe('abcdef1 · 2h ago')
    expect(impactMeta('abcdef1234', IMPACT.updatedAt, [{ version: 1, updatedAt: '', files: [] }, { version: 3, updatedAt: '', files: [] }], NOW))
      .toBe('abcdef1 · 2h ago · v3')
  })
})

describe('ImpactControl', () => {
  it('never assessed: Assess impact posts the subject and flips to Assessing…', async () => {
    const client = mount()
    await stateOf('assess')
    const button = screen.getByRole('button', { name: 'Assess impact' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    answer = found({ artifacts: [], run: { id: 'r10', status: 'running', title: 'x', createdAt: '' } })
    fireEvent.click(button)
    await waitFor(() => expect(posted).toEqual([{ subject: { kind: 'pr', number: 12 } }]))
    await stateOf('assessing')
    expect(screen.getByText('Assessing…')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to task' }).getAttribute('href')).toBe('/tasks/r10')
    void client
  })

  it('Assessing… → Open impact live: the runs list and the artifacts patch move it, no poll', async () => {
    answer = found({ artifacts: [], run: { id: 'r9', status: 'running', title: 'x', createdAt: '' } })
    runs = [{ id: 'r9', status: 'running' }]
    const client = mount()
    await stateOf('assessing')
    // The stream finishes the run and publishes the report.
    answer = found()
    act(() => {
      client.setQueryData(queryKeys.runs.list(), [{ id: 'r9', status: 'done' }])
    })
    await stateOf('open')
    expect(screen.getByRole('button', { name: 'Open impact' })).toBeTruthy()
  })

  it('done with a report: Open impact navigates to Assets, Re-assess is secondary, meta shown', async () => {
    answer = found({ versions: [{ version: 1, updatedAt: '', files: ['impact.html'] }, { version: 2, updatedAt: '', files: ['impact.html'] }] })
    mount()
    await stateOf('open')
    const meta = document.querySelector('[data-slot="impact-meta"]')?.textContent ?? ''
    expect(meta).toMatch(/^abcdef1 · .+ ago · v2$/)
    expect(screen.getByRole('button', { name: 'Re-assess' })).toBeTruthy()
    expect(document.querySelector('[data-slot="impact-stale"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open impact' }))
    expect(screen.getByTestId('where').textContent).toBe('/tasks/r9/assets/impact.html')
  })

  it('stale: the Stale chip shows and Re-assess posts again', async () => {
    answer = found({ stale: true })
    mount()
    await stateOf('stale')
    expect(screen.getByText('Stale')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Re-assess' }))
    await waitFor(() => expect(posted).toHaveLength(1))
  })

  it('a missing prerequisite disables the action with the reason as visible text', async () => {
    mount('Assess impact needs GitHub: gh is not installed.')
    await stateOf('assess')
    const button = screen.getByRole('button', { name: 'Assess impact' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    const reason = screen.getByText('Assess impact needs GitHub: gh is not installed.')
    expect(reason.getAttribute('data-slot')).toBe('impact-reason')
    expect(button.getAttribute('aria-describedby')).toBe(reason.id)
  })

  it('a refused POST (409) disables the action and shows the server reason', async () => {
    post = { status: 409, body: { error: 'pull request #12 is not open' } }
    mount()
    await stateOf('assess')
    fireEvent.click(screen.getByRole('button', { name: 'Assess impact' }))
    expect(await screen.findByText('pull request #12 is not open')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Assess impact' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
