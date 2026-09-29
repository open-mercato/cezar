import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import type { ApiRun, LandingCheck, RunEvent } from '@open-mercato/cezar-api-client'

import { LandingCheckCard } from './landing-check-card'

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  act(() => resetToasts())
  vi.unstubAllGlobals()
})

function check(over: Partial<LandingCheck> = {}): LandingCheck {
  return {
    ofRunId: 'parent',
    subject: {
      baseRef: 'cez/parent',
      baseSha: 'a'.repeat(40),
      sources: [{ ref: 'cez/child', sha: 'b'.repeat(40) }],
      order: 'ledger',
    },
    ...over,
  }
}

function run(over: Partial<ApiRun> = {}): ApiRun {
  return {
    id: 'check-run',
    title: 'Landing check — parent',
    workflow: 'landing-check',
    task: 'landing check',
    status: 'done',
    createdAt: '2026-09-29T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    landingCheck: check(),
    ...over,
  }
}

let seq = 0
function output(over: Record<string, unknown>): RunEvent {
  seq += 1
  return { seq, ts: '2026-09-29T10:00:00.000Z', type: 'check-output', ...over }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The card's `useRuns()` is the page's already-warm list; a stub keeps the test offline. */
function stubRuns(runs: ApiRun[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(runs)),
  )
}

function renderCard(record: ApiRun, events: RunEvent[] = []) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/check-run']}>
        <Routes>
          <Route path="/tasks/:id" element={<LandingCheckCard run={record} events={events} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/**
 * The card with somewhere for a navigation to LAND (the ack follows the new check run's id) and a
 * `<Toaster />` mounted, so a refused ack is asserted where the user would read it.
 */
function renderCardFollowingLandings(record: ApiRun, events: RunEvent[] = []) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/check-run']}>
        <Routes>
          <Route path="/tasks/check-run" element={<LandingCheckCard run={record} events={events} />} />
          <Route path="/tasks/:id" element={<LandedRunProbe />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function LandedRunProbe() {
  const { id } = useParams()
  return <div data-testid="landed-run">{id}</div>
}

describe('LandingCheckCard — per-command rows (sign-off a)', () => {
  it('renders one row per command with its exit code and, expanded, the tail of the output', () => {
    stubRuns()
    renderCard(
      run({
        landingCheck: check({
          subject: {
            baseRef: 'cez/parent',
            baseSha: 'a'.repeat(40),
            sources: [{ ref: 'cez/child', sha: 'b'.repeat(40) }],
            order: 'ledger',
            treeSha: 'd'.repeat(40),
          },
          commands: { source: 'agentic-config', digest: 'abc' },
          verdict: 'failed',
          reason: 'command-failed',
          results: [
            { command: 'npm test', exitCode: 0, outcome: 'passed', startedAt: 't1' },
            { command: 'npm run lint', exitCode: 2, outcome: 'failed', startedAt: 't2' },
          ],
        }),
      }),
      [
        output({ command: 'npm test', exitCode: 0, text: '72 passing (1.2s)' }),
        output({ command: 'npm run lint', exitCode: 2, text: '2 problems (0 errors, 2 warnings)' }),
      ],
    )

    const rows = document.querySelectorAll('[data-slot="landing-check-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-outcome')).toBe('passed')
    expect(rows[1]!.getAttribute('data-outcome')).toBe('failed')
    expect(rows[0]!.querySelector('[data-slot="landing-check-exit"]')?.textContent).toBe('0')
    expect(rows[1]!.querySelector('[data-slot="landing-check-exit"]')?.textContent).toBe('2')
    expect(rows[1]!.textContent).toContain('npm run lint')
    expect(rows[1]!.textContent).toContain('failed')

    // The tail lives in the collapsed body until the reader opens the row.
    expect(screen.queryByText(/2 problems/)).toBeNull()
    fireEvent.click(rows[1]!.querySelector('button') as HTMLElement)
    expect(screen.getByText(/2 problems/)).not.toBeNull()
  })

  it('renders the install step first, as its own row, and says "Installed"', () => {
    stubRuns()
    renderCard(
      run({
        landingCheck: check({
          install: { argv: ['npm', 'ci'], exitCode: 0, outcome: 'passed' },
          commands: { source: 'package-json', digest: 'abc' },
          verdict: 'passed',
          results: [{ command: 'npm test', exitCode: 0, outcome: 'passed', startedAt: 't1' }],
        }),
      }),
      [
        output({ command: 'npm ci', exitCode: 0, text: 'added 476 packages' }),
        output({ command: 'npm test', exitCode: 0, text: 'green' }),
      ],
    )
    const rows = document.querySelectorAll('[data-slot="landing-check-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('data-kind')).toBe('install')
    expect(rows[0]!.textContent).toContain('Installed')
    expect(rows[0]!.querySelector('[data-slot="landing-check-exit"]')?.textContent).toBe('0')
  })

  it('folds a failed command\'s tail away by default but keeps the exit code prominent', () => {
    stubRuns()
    renderCard(
      run({
        landingCheck: check({
          commands: { source: 'explicit', digest: 'abc' },
          verdict: 'failed',
          results: [{ command: 'make test', exitCode: 1, outcome: 'failed', startedAt: 't1' }],
        }),
      }),
      [output({ command: 'make test', exitCode: 1, text: '1 failing' })],
    )
    expect(document.querySelector('[data-slot="landing-check-row"]')?.getAttribute('data-outcome')).toBe('failed')
    expect(screen.queryByText('1 failing')).toBeNull()
  })
})

describe('LandingCheckCard — the honest two-stage empty state', () => {
  it('a subject-only record shows freezing done, merging pending — never fake rows', () => {
    stubRuns()
    renderCard(run({ status: 'running' }))
    const stages = document.querySelectorAll('[data-slot="landing-check-stages"] [data-stage]')
    expect([...stages].map((stage) => [stage.getAttribute('data-stage'), stage.getAttribute('data-state')])).toEqual([
      ['freeze', 'done'],
      ['merge', 'pending'],
      ['gate', 'pending'],
    ])
    expect(document.querySelectorAll('[data-slot="landing-check-row"]')).toHaveLength(0)
    // The frozen subject is stated, not implied.
    expect(screen.getByText(/cez\/parent/)).not.toBeNull()
  })

  it('once the tree sha exists, merging reads done and only the gate is pending', () => {
    stubRuns()
    renderCard(
      run({
        status: 'running',
        landingCheck: check({
          subject: {
            baseRef: 'cez/parent',
            baseSha: 'a'.repeat(40),
            sources: [],
            order: 'ledger',
            treeSha: 'e'.repeat(40),
          },
        }),
      }),
    )
    const stages = [...document.querySelectorAll('[data-slot="landing-check-stages"] [data-stage]')]
    expect(stages.map((stage) => stage.getAttribute('data-state'))).toEqual(['done', 'done', 'pending'])
    expect(screen.getByText(/no eligible sources/)).not.toBeNull()
  })
})

describe('LandingCheckCard — verdicts that are not green (sign-off c)', () => {
  it('nothing-to-check renders neutral, with a note, never the success tone', () => {
    stubRuns()
    renderCard(
      run({
        landingCheck: check({ verdict: 'nothing-to-check', reason: 'commands-changed-vs-base' }),
      }),
    )
    const chip = document.querySelector('[data-slot="landing-check-chip"]')
    expect(chip?.getAttribute('data-state')).toBe('nothing-to-check')
    expect(chip?.querySelector('[data-tone="success"]')).toBeNull()
    expect(document.querySelector('[data-slot="landing-check-reason"]')?.textContent).toContain('commands changed vs base')
    expect(document.querySelector('[data-slot="landing-check-empty"]')?.textContent).toContain('Nothing was executed')
  })

  it('could-not-run renders pending, says "not a pass", and never the success tone', () => {
    stubRuns()
    renderCard(run({ landingCheck: check({ verdict: 'could-not-run', reason: 'install-failed' }) }))
    const chip = document.querySelector('[data-slot="landing-check-chip"]')
    expect(chip?.getAttribute('data-state')).toBe('could-not-run')
    expect(chip?.querySelector('[data-tone="success"]')).toBeNull()
    expect(document.querySelector('[data-slot="landing-check-empty"]')?.textContent).toContain('not a pass')
  })

  it('a conflict explains that nothing ran and where the conflict was', () => {
    stubRuns()
    renderCard(run({ landingCheck: check({ verdict: 'conflict', reason: 'merge-conflict' }) }))
    expect(document.querySelector('[data-slot="landing-check-empty"]')?.textContent).toContain('No command ran')
    expect(document.querySelector('[data-slot="landing-check-card"]')?.getAttribute('data-state')).toBe('conflict')
  })

  it('counts the commands the engine stopped before running', () => {
    stubRuns()
    renderCard(
      run({
        status: 'failed',
        steps: [
          { id: 'check-1', name: 'npm test', kind: 'check', status: 'failed', iterations: 1, tokensUsed: 0 },
          { id: 'check-2', name: 'npm run lint', kind: 'check', status: 'pending', iterations: 0, tokensUsed: 0 },
        ] as ApiRun['steps'],
        landingCheck: check({
          verdict: 'failed',
          results: [{ command: 'npm test', exitCode: 1, outcome: 'failed', startedAt: 't' }],
        }),
      }),
    )
    expect(document.querySelector('[data-slot="landing-check-not-run"]')?.textContent).toContain('1 more command')
  })
})

describe('LandingCheckCard — stale, the invoking link and preview', () => {
  it('marks a stale verdict beside the chip', () => {
    stubRuns()
    renderCard(run({ landingCheckStale: true, landingCheck: check({ verdict: 'passed' }) }))
    expect(document.querySelector('[data-slot="landing-check-chip"]')?.getAttribute('data-state')).toBe('stale')
    expect(document.querySelector('[data-slot="landing-check-stale"]')?.textContent).toContain('stale')
  })

  it('links back to the invoking run, by title when the page already holds it (sign-off d)', async () => {
    stubRuns([
      {
        id: 'parent',
        title: 'Land the feature',
        workflow: 'default',
        task: 'land the feature',
        status: 'running',
        createdAt: '2026-09-29T09:00:00.000Z',
        tokensUsed: 0,
        archived: false,
        steps: [],
      },
    ])
    renderCard(run())
    const link = document.querySelector('[data-slot="landing-check-invoking-run"]')
    expect(link?.getAttribute('href')).toBe('/tasks/parent')
    // Before the (already warm, in the app) runs list answers, the id is the honest label.
    expect(link?.textContent).toContain('parent')
    await waitFor(() => expect(link?.textContent).toContain('Land the feature'))
  })

})

/** A foreign-subject preview, exactly what the engine writes before anything executes. */
function previewCheck(over: Partial<LandingCheck> = {}): LandingCheck {
  return check({
    verdict: 'could-not-run',
    reason: 'foreign-subject-needs-ack',
    preview: {
      subjectDigest: 'digest-1',
      authors: ['someone-else'],
      commands: ['npm test'],
      installArgv: ['npm', 'ci'],
      headSha: 'f'.repeat(40),
      diffStat: '+2 −1',
    },
    ...over,
  })
}

describe('LandingCheckCard — the acknowledgement round-trip (PR 5.1)', () => {
  it('renders the preview neutrally — authors, install argv, commands, diffstat — with the deliberate control', () => {
    stubRuns()
    renderCard(run({ status: 'failed', landingCheck: previewCheck() }))

    const preview = document.querySelector('[data-slot="landing-check-preview"]')
    expect(preview?.textContent).toContain('Preview — nothing was executed')
    expect(preview?.textContent).toContain('someone-else')
    expect(preview?.textContent).toContain('install: npm ci')
    expect(preview?.textContent).toContain('npm test')
    expect(preview?.textContent).toContain('+2 −1')
    // The consequence is legible at the click: it runs the gate as the operator, and it is not a
    // sandbox. The block stays neutral — no green, no red.
    expect(preview?.textContent).toContain('not a sandbox')
    expect(preview?.querySelector('[data-tone="success"]')).toBeNull()
    expect(preview?.querySelector('[data-tone="danger"]')).toBeNull()
    expect(screen.getByRole('button', { name: /acknowledge and run/i })).not.toBeNull()
  })

  it('shows no control on a check that has no preview', () => {
    stubRuns()
    renderCard(run({ landingCheck: check({ verdict: 'could-not-run', reason: 'install-failed' }) }))
    expect(document.querySelector('[data-slot="landing-check-preview"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull()
  })

  it('posts the preview digest to the INVOKING run and follows the new check run', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
        return method === 'POST' ? jsonResponse({ runId: 'check-2', ofRunId: 'parent' }, 201) : jsonResponse([])
      }),
    )
    renderCardFollowingLandings(run({ status: 'failed', landingCheck: previewCheck() }))

    fireEvent.click(screen.getByRole('button', { name: /acknowledge and run/i }))

    // The new check run's id is where the reader lands — the card never claims the verdict itself.
    await waitFor(() => expect(screen.getByTestId('landed-run').textContent).toBe('check-2'))
    const post = calls.find((call) => call.method === 'POST')
    // `ofRunId` (the run whose combination is checked), never the check run's own id: the ack
    // asks for a NEW check of the invoking run.
    expect(post?.url).toBe('/api/v1/runs/parent/land-check')
    expect(post?.body).toEqual({ acknowledge: { digest: 'digest-1' } })
    // Nothing fired before the click.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('surfaces a refused ack (a check already in flight) and stays on the card', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? jsonResponse({ error: 'a landing check is already in flight for this project (run abcd1234) — wait for its verdict before starting another' }, 409)
          : jsonResponse([]),
      ),
    )
    renderCardFollowingLandings(run({ status: 'failed', landingCheck: previewCheck() }))

    fireEvent.click(screen.getByRole('button', { name: /acknowledge and run/i }))

    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain('already in flight'),
    )
    // The server's words, not a navigate: the reader stays where the click happened.
    expect(screen.queryByTestId('landed-run')).toBeNull()
    expect(screen.getByRole('button', { name: /acknowledge and run/i })).not.toBeNull()
  })
})

describe('LandingCheckCard — a dead run without a verdict (PR #1169 review, low)', () => {
  it('paints no stage with the success tone and no stage as still in progress', () => {
    stubRuns()
    renderCard(run({ status: 'failed', landingCheck: check() }))

    const stages = [...document.querySelectorAll('[data-slot="landing-check-stages"] [data-stage]')]
    expect(stages.map((stage) => stage.getAttribute('data-stage'))).toEqual(['freeze', 'merge', 'gate'])
    // The chip already reads could-not-run; a green freeze dot on the same card contradicts it.
    expect(document.querySelectorAll('[data-slot="landing-check-stages"] [data-tone="success"]')).toHaveLength(0)
    for (const stage of stages) expect(stage.querySelector('[data-tone="neutral"]')).not.toBeNull()
    // Past tense: "applying the pinned sources one by one" reads as live work on a dead run.
    expect(stages[1]?.textContent).toContain('the check ended before the sources were merged')
    expect(stages[2]?.textContent).toContain('the gate never ran on this subject')
    expect(document.body.textContent).not.toContain('applying the pinned sources one by one')
  })

  it('keeps a live run\'s trail as progress: success for what is done, pending for what is not', () => {
    stubRuns()
    renderCard(run({ status: 'running', landingCheck: check() }))
    const stages = [...document.querySelectorAll('[data-slot="landing-check-stages"] [data-stage]')]
    expect(stages[0]?.querySelector('[data-tone="success"]')).not.toBeNull()
    expect(stages[1]?.querySelector('[data-tone="pending"]')).not.toBeNull()
    expect(stages[1]?.textContent).toContain('applying the pinned sources one by one')
  })
})
