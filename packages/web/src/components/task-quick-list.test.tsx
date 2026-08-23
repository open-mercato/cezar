import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { ListViewProvider } from '@/components/list-view'
import { TaskQuickList, TaskQuickListContainer } from '@/components/task-quick-list'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let seq = 0

function run(over: Partial<RunRecord> = {}): RunRecord {
  seq += 1
  return {
    id: `r${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: ago(60_000),
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

function renderList(props: Partial<Parameters<typeof TaskQuickList>[0]> = {}, route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TaskQuickList runs={[]} now={NOW} {...props} />
    </MemoryRouter>
  )
}

const bucket = (label: string): HTMLElement => {
  const node = document.querySelector(`[data-bucket="${label}"]`)
  if (!node) throw new Error(`no "${label}" bucket rendered`)
  return node as HTMLElement
}

const row = (id: string) => document.querySelector(`[data-run-id="${id}"]`)
const dotOf = (id: string) => document.querySelector(`[data-run-id="${id}"] [data-slot="status-mark"]`)

/** The rendered text of each row under one bucket header, in order. */
const rowsIn = (label: string): string[] =>
  [...bucket(label).querySelectorAll('[data-slot="task-row"], [data-slot="group-tile"]')].map((el) =>
    (el.textContent ?? '').trim()
  )

afterEach(cleanup)

describe('TaskQuickList', () => {
  it('renders the buckets in the mockup order with their runs', () => {
    renderList({
      runs: [
        run({ id: 'a', title: 'Structured changes endpoint', status: 'review' }),
        run({ id: 'b', title: 'Normalize agent-event protocol', status: 'running' }),
        run({ id: 'c', title: 'README parallel-agents tagline', status: 'done' }),
      ],
    })

    // Flat list: the buckets still ORDER the rows but paint no headings of their own.
    const order = [...document.querySelectorAll('[data-slot="quick-list-bucket"]')].map((el) =>
      el.getAttribute('data-bucket'),
    )
    expect(order).toEqual(['Needs you', 'Working', 'Recent'])
    expect(document.querySelectorAll('[data-slot="quick-list-bucket"] h2')).toHaveLength(0)
    expect(rowsIn('Needs you')).toEqual(['Structured changes endpoint1m'])
    expect(rowsIn('Working')).toEqual(['Normalize agent-event protocol1m'])
    expect(rowsIn('Recent')).toEqual(['README parallel-agents tagline1m'])
  })

  it('links every row to its task', () => {
    renderList({ runs: [run({ id: 'abc123', title: 'Bump zod to v4' })] })
    expect(screen.getByRole('link', { name: /Bump zod to v4/ }).getAttribute('href')).toBe('/tasks/abc123')
  })

  it('names a row by its auto-summary once one exists — the title, the tooltip and the PR chip agree', () => {
    renderList({
      runs: [
        run({
          id: 'sum',
          title: 'fix the login bug plz',
          titleSummary: 'Catch AuthError in the login handler',
          status: 'review',
          pullRequestUrl: 'https://github.com/o/r/pull/9',
        }),
        run({ id: 'raw', title: 'fix the search crash' }),
      ],
    })

    const link = row('sum')?.querySelector('a[href="/tasks/sum"]') as HTMLElement
    expect(link.textContent).toContain('Catch AuthError in the login handler')
    expect(link.getAttribute('title')).toBe('Catch AuthError in the login handler')
    expect(row('sum')?.textContent).not.toContain('fix the login bug plz')
    expect(
      within(row('sum') as HTMLElement).getByRole('link', {
        name: 'Open the pull request for Catch AuthError in the login handler',
      })
    ).not.toBeNull()
    // No summary yet (or a pre-R2 record) → the raw title, honestly.
    expect(within(row('raw') as HTMLElement).getByRole('link', { name: /fix the search crash/ })).not.toBeNull()
  })

  it('shows the diff pair when a turn recorded one, and nothing when none exists', () => {
    renderList({
      runs: [
        run({ id: 'diffed', title: 'Has a diff', status: 'review', diffStat: { adds: 42, dels: 7, files: 3 } }),
        run({ id: 'plain', title: 'No diff yet', status: 'review' }),
      ],
    })

    const pair = row('diffed')?.querySelector('[data-slot="diff-stat"]')
    expect(pair?.textContent).toBe('+42 −7')
    // Two colored halves through the design tokens — green adds, red dels, like the mockup.
    expect(pair?.querySelector('.text-success')?.textContent).toBe('+42')
    expect(pair?.querySelector('.text-danger')?.textContent).toBe('−7')
    // A sidebar row has no ± column to hold an em dash open for — absence is just absence.
    expect(row('plain')?.querySelector('[data-slot="diff-stat"]')).toBeNull()
    expect(row('plain')?.textContent).not.toContain('—')
  })

  it('flags a repointed-worktree diff so the sidebar number explains itself (#751)', () => {
    renderList({
      runs: [
        run({ id: 'review', title: 'Review PR 694', status: 'review', diffStat: { adds: 1, dels: 0, files: 1, repointed: true } }),
        run({ id: 'own', title: 'Own work', status: 'review', diffStat: { adds: 42, dels: 7, files: 3 } }),
      ],
    })

    const narrowed = row('review')?.querySelector('[data-slot="diff-stat"]')
    expect(narrowed?.textContent).toBe('+1 −0')
    expect(narrowed?.getAttribute('data-repointed')).toBe('true')
    expect(narrowed?.getAttribute('title')).toContain('as this task found it')
    // A task working on its own branch is untouched by the annotation.
    expect(row('own')?.querySelector('[data-slot="diff-stat"]')?.getAttribute('data-repointed')).toBeNull()
  })

  it('marks the row for the open task active, from the route', () => {
    const runs = [run({ id: 'open', title: 'Open one' }), run({ id: 'other', title: 'Other one' })]
    renderList({ runs, currentRunId: 'open' }, '/tasks/open')

    const active = document.querySelectorAll('[data-slot="task-row"] a[aria-current="page"]')
    expect(active).toHaveLength(1)
    expect(active[0]?.getAttribute('href')).toBe('/tasks/open')
    expect(row('open')?.getAttribute('data-active')).toBe('true')
    expect(row('other')?.getAttribute('data-active')).toBeNull()
  })

  describe('status dots', () => {
    it('paints one dot per row, from deriveAttention', () => {
      renderList({
        runs: [
          run({ id: 'w', status: 'waiting' }),
          run({ id: 'v', status: 'review' }),
          run({ id: 'r', status: 'running' }),
          run({ id: 'd', status: 'done' }),
          run({ id: 'f', status: 'failed' }),
        ],
      })
      expect(dotOf('w')?.getAttribute('data-tone')).toBe('pending')
      // Review is amber now — your move, like waiting — told apart from it by its glyph.
      expect(dotOf('v')?.getAttribute('data-tone')).toBe('pending')
      expect(dotOf('v')?.getAttribute('data-kind')).toBe('review')
      expect(dotOf('r')?.getAttribute('data-tone')).toBe('violet')
      expect(dotOf('d')?.getAttribute('data-tone')).toBe('success')
      expect(dotOf('f')?.getAttribute('data-tone')).toBe('danger')

      // Exactly one dot per row — the design system's "a single 7px dot per row" rule.
      expect(document.querySelectorAll('[data-run-id="w"] [data-slot="status-mark"]')).toHaveLength(1)
      expect(dotOf('w')?.getAttribute('aria-label')).toBe('needs you')
    })

    it('pulses the transitioning rows only', () => {
      renderList({ runs: [run({ id: 'r', status: 'running' }), run({ id: 'd', status: 'done' })] })
      // Motion rides the glyph: a slow spin for the agent at work, nothing on a finished run.
      expect(dotOf('r')?.querySelector('svg')?.getAttribute('class')).toContain('animate-spin')
      expect(dotOf('d')?.querySelector('svg')?.getAttribute('class')).not.toMatch(/animate-/)
    })
  })

  describe('the PR chip', () => {
    it('appears only when the run has a pullRequestUrl, and opens it', () => {
      renderList({
        runs: [
          run({ id: 'with', title: 'Has a PR', status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/7' }),
          run({ id: 'without', title: 'No PR', status: 'review' }),
        ],
      })

      const chip = within(row('with') as HTMLElement).getByRole('link', {
        name: 'Open the pull request for Has a PR',
      })
      expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/7')
      expect(chip.getAttribute('target')).toBe('_blank')
      expect(chip.getAttribute('rel')).toBe('noopener noreferrer')

      expect(document.querySelector('[data-run-id="without"] [data-slot="pr-chip"]')).toBeNull()
    })

    it('also appears for a referenced PR — the task worked ON it (#407)', () => {
      renderList({
        runs: [
          run({
            id: 'ref',
            title: 'Review task',
            status: 'review',
            referencedPullRequestUrl: 'https://github.com/o/r/pull/4170',
          }),
        ],
      })
      const chip = within(row('ref') as HTMLElement).getByRole('link', {
        name: 'Open the pull request for Review task',
      })
      expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/4170')
    })

    it('is a sibling of the row link, not nested inside it', () => {
      // Two independent targets: the row opens the task, the chip opens the PR. An anchor inside
      // an anchor is invalid HTML, and only one of them would ever fire — so the chip lives on
      // the META line beside the title link, never inside it.
      renderList({ runs: [run({ id: 'x', pullRequestUrl: 'https://github.com/o/r/pull/7' })] })
      const chip = document.querySelector('[data-slot="pr-chip"]') as HTMLElement
      expect(chip.closest('a[href^="/tasks/"]')).toBeNull()
      expect(chip.parentElement?.getAttribute('data-slot')).toBe('task-row-meta')
    })

    it('sits on the meta line under the name, spelling the number rather than the word "PR" (#788)', () => {
      renderList({
        runs: [run({ id: 'x', title: 'Has a PR', status: 'review', pullRequestUrl: 'https://github.com/o/r/pull/7' })],
      })
      // Two lines (Devin-style): the name first, then age and reference beneath it.
      expect(rowsIn('Needs you')).toEqual(['Has a PR1m#7'])
    })

    it('carries the issue when no PR exists yet — the number the title prefix was about', () => {
      renderList({
        runs: [
          run({
            id: 'iss',
            title: '788: implementing readable task names',
            status: 'running',
            referencedIssueUrl: 'https://github.com/o/r/issues/788',
          }),
        ],
      })
      const chip = within(row('iss') as HTMLElement).getByRole('link', {
        name: 'Open the issue for 788: implementing readable task names',
      })
      expect(chip.getAttribute('href')).toBe('https://github.com/o/r/issues/788')
      // `#788`, not `Issue #788`: in this column the word costs six glyphs the name needs.
      expect(chip.textContent).toBe('#788')
    })

    it('still paints a number it cannot link — an inert chip beats losing the reference', () => {
      // A record that knows its PR number but has no URL (or a non-http one, #431). The title's
      // prefix is dropped in favour of the chip, so the chip has to exist or the number is gone.
      renderList({ runs: [run({ id: 'noturl', title: '402: no url for this one', prNumber: 402 })] })
      const chip = document.querySelector('[data-run-id="noturl"] [data-slot="pr-chip"]') as HTMLElement
      expect(chip.tagName).toBe('SPAN')
      expect(chip.textContent).toBe('#402')
    })
  })

  describe('the title vs. its metadata (#788, option C)', () => {
    it('drops the NNN: prefix the chip is already showing, and keeps the full title on hover', () => {
      renderList({
        runs: [
          run({
            id: 'dedup',
            title: '775: implementing comment threads',
            status: 'review',
            pullRequestUrl: 'https://github.com/o/r/pull/775',
          }),
        ],
      })

      const title = document.querySelector('[data-run-id="dedup"] [data-slot="task-row-title"]')
      expect(title?.textContent).toBe('implementing comment threads')
      // Nothing is lost: the number is a chip, and the stored title is still the row's tooltip.
      expect(document.querySelector('[data-run-id="dedup"] [data-slot="pr-chip"]')?.textContent).toBe('#775')
      expect(
        document.querySelector('[data-run-id="dedup"] a[href="/tasks/dedup"]')?.getAttribute('title')
      ).toBe('775: implementing comment threads')
    })

    it('keeps the prefix when it is a DIFFERENT number from the chip — two facts, not one', () => {
      // Opened on issue #788, shipped as PR #790. Stripping `788: ` here would delete the only
      // place the issue number appears.
      renderList({
        runs: [
          run({
            id: 'two',
            title: '788: implementing readable task names',
            status: 'review',
            pullRequestUrl: 'https://github.com/o/r/pull/790',
            referencedIssueUrl: 'https://github.com/o/r/issues/788',
          }),
        ],
      })
      expect(document.querySelector('[data-run-id="two"] [data-slot="task-row-title"]')?.textContent).toBe(
        '788: implementing readable task names'
      )
      expect(document.querySelector('[data-run-id="two"] [data-slot="pr-chip"]')?.textContent).toBe('#790')
    })

    it('keeps a leading number that is not a reference at all', () => {
      renderList({ runs: [run({ id: 'year', title: '2026: the year in review' })] })
      expect(document.querySelector('[data-run-id="year"] [data-slot="task-row-title"]')?.textContent).toBe(
        '2026: the year in review'
      )
    })

    it('gives the title a floor and makes the diff pair the element that drops', () => {
      // The worst case from the issue: a title competing with a 5-digit diff pair, a PR chip and
      // the unread dot all at once. The title must still be the growing element with a floor,
      // and the diff pair must be the one carrying the container query that drops it.
      renderList({
        runs: [
          run({
            id: 'worst',
            title: '775: implementing comment threads across the whole thread view',
            status: 'done',
            finishedAt: ago(60_000),
            diffStat: { adds: 59_514, dels: 12_160, files: 208 },
            pullRequestUrl: 'https://github.com/o/r/pull/775',
          }),
        ],
      })

      const rowEl = row('worst') as HTMLElement
      const title = rowEl.querySelector('[data-slot="task-row-title"]') as HTMLElement
      // The title owns its whole line now (two-line row): it grows, truncates, and competes with
      // nothing but the unread marker.
      expect(title.className).toContain('flex-1')
      expect(title.className).toContain('truncate')
      expect(title.textContent).toBe('implementing comment threads across the whole thread view')

      const diff = rowEl.querySelector('[data-slot="diff-stat"]') as HTMLElement
      // On the meta line: hidden at the 264px column, back once the column is dragged past
      // 20rem — the meta line has no name to protect, so it can afford the pair sooner.
      expect(diff.className).toContain('hidden')
      expect(diff.className).toContain('@min-[20rem]/sidebar:inline')
      // Dropped from view, never from reach — the exact numbers stay in its tooltip.
      expect(diff.getAttribute('title')).toBe('+59514 −12160 across 208 files')

      // Everything the row paints, in reading order: name, then the meta line — age,
      // reference, diff.
      expect(rowsIn('Recent')).toEqual(['implementing comment threads across the whole thread viewunread1m#775+59514 −12160'])
    })

    it('gives the collapsed variant tile the same floor', () => {
      renderList({
        runs: [
          run({ id: 'ga', title: 'Add skills autocomplete (A)', groupId: 'g', variant: 'A' }),
          run({ id: 'gb', title: 'Add skills autocomplete (B)', groupId: 'g', variant: 'B' }),
        ],
      })
      const tileTitle = document.querySelector('[data-slot="group-tile"] span') as HTMLElement
      expect(tileTitle.className).toContain('min-w-[7rem]')
    })
  })

  describe('ages and queue positions', () => {
    it('shows a compact age, from finishedAt once the run is over', () => {
      renderList({
        runs: [
          run({
            id: 'old',
            title: 'Old',
            status: 'done',
            createdAt: ago(9 * 3_600_000),
            finishedAt: ago(2 * 3_600_000),
          }),
          run({ id: 'new', title: 'New', status: 'running', createdAt: ago(4 * 60_000) }),
        ],
      })
      expect(row('old')?.textContent).toBe('Oldunread2h')
      expect(row('new')?.textContent).toBe('New4m')
    })

    it('shows the queue position instead of an age for queued runs', () => {
      renderList({
        runs: [
          run({ id: 'q1', title: 'First', status: 'queued', createdAt: ago(120_000) }),
          run({ id: 'q2', title: 'Second', status: 'queued', createdAt: ago(60_000) }),
        ],
      })
      expect(row('q1')?.textContent).toBe('Firstqueue #1')
      expect(row('q2')?.textContent).toBe('Secondqueue #2')
    })

    it('keeps the queue position even when the row has a reference chip', () => {
      // The chip takes the AGE's slot, never the queue position's: `#1` is where the engine will
      // pick this run up, it is carried nowhere else in the row, and an issue-driven queued run —
      // an issue reference, no PR yet — is exactly the shape that would have silently lost it.
      renderList({
        runs: [
          run({
            id: 'qref',
            title: '788: queued on an issue',
            status: 'queued',
            createdAt: ago(120_000),
            referencedIssueUrl: 'https://github.com/o/r/issues/788',
          }),
        ],
      })
      expect(row('qref')?.textContent).toBe('queued on an issuequeue #1#788')
    })

    it('keeps the age beside the reference on the meta line', () => {
      renderList({
        runs: [
          run({
            id: 'aged',
            title: 'Finished with a PR',
            status: 'done',
            finishedAt: ago(2 * 3_600_000),
            pullRequestUrl: 'https://github.com/o/r/pull/9',
          }),
        ],
      })
      expect(row('aged')?.textContent).toBe('Finished with a PRunread2h#9')
    })
  })

  describe('variant groups', () => {
    const variants = () => [
      run({
        id: 'va',
        groupId: 'g1',
        variant: 'A',
        title: 'Add skills autocomplete (A)',
        status: 'running',
        runner: 'claude',
        tokensUsed: 96_249,
        inputTokens: 92_000,
        outputTokens: 4_249,
        costUsd: 0.31,
      }),
      run({
        id: 'vb',
        groupId: 'g1',
        variant: 'B',
        title: 'Add skills autocomplete (B)',
        status: 'running',
        runner: 'codex',
        tokensUsed: 41_800,
        inputTokens: 40_000,
        outputTokens: 1_800,
        costUsd: 0.12,
      }),
    ]

    it('collapses into one tile with the shared title and an ×N count', () => {
      renderList({ runs: variants() })

      const tile = screen.getByRole('button', { expanded: false })
      expect(tile.textContent).toBe('Add skills autocomplete×2')
      // Collapsed: the members are not rows of their own.
      expect(row('va')).toBeNull()
      expect(row('vb')).toBeNull()
    })

    it('expands and collapses on click, showing a lettered row per variant', () => {
      renderList({ runs: variants() })

      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(screen.getByRole('button', { expanded: true })).not.toBeNull()

      // The letter chip, its own dot, and what actually differs between the variants.
      expect(row('va')?.textContent).toBe('Aclaude, IN 92.0k / OUT 4.2k, $0.31')
      expect(row('vb')?.textContent).toBe('Bcodex, IN 40.0k / OUT 1.8k, $0.12')
      expect(dotOf('va')?.getAttribute('data-tone')).toBe('violet')
      // Each variant is still its own deep link.
      expect(row('vb')?.querySelector('a')?.getAttribute('href')).toBe('/tasks/vb')

      fireEvent.click(screen.getByRole('button', { expanded: true }))
      expect(row('va')).toBeNull()
    })

    it('offers a ⚖ compare link beside the tile, pointing at /compare/:groupId', () => {
      renderList({ runs: variants() })

      // A sibling of the toggle button, never its child — a link inside a button is invalid.
      const link = screen.getByRole('link', { name: 'Compare the variants of Add skills autocomplete' })
      expect(link.getAttribute('href')).toBe('/compare/g1')
      expect(link.closest('button')).toBeNull()
    })

    it('omits unknown token directions while preserving independently visible cost', () => {
      renderList({
        runs: variants().map((v, i) =>
          i === 0 ? { ...v, inputTokens: undefined, outputTokens: undefined } : v,
        ),
      })
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(row('va')?.textContent).toBe('Aclaude, $0.31')
    })

    it('gates variant token directions and cost independently', () => {
      renderList({ runs: variants(), showTokens: false, showCost: true })
      fireEvent.click(screen.getByRole('button', { expanded: false }))
      expect(row('va')?.textContent).toBe('Aclaude, $0.31')
      expect(row('vb')?.textContent).toBe('Bcodex, $0.12')
    })
  })

  describe('the flat list (Claude-sessions style: no view rows, no bucket headings)', () => {
    const runs = () => [
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'waiting' }),
      run({ id: 'c', status: 'done', archived: true }),
    ]

    it('renders the live tasks only — the archive lives behind the Tasks page tab', () => {
      renderList({ runs: runs() })
      expect(row('a')).not.toBeNull()
      expect(row('b')).not.toBeNull()
      expect(row('c')).toBeNull()
      expect(screen.queryByRole('button', { name: /Active/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Archived/ })).toBeNull()
    })

    it('shows no bucket headings — order and the status dots carry the grouping', () => {
      renderList({ runs: runs() })
      // The bucket wrappers survive (order comes from them) but their labels do not render.
      expect(document.querySelectorAll('[data-slot="quick-list-bucket"] h2')).toHaveLength(0)
      // Needs-you ordering still leads: the waiting run's bucket precedes the working one's.
      const order = [...document.querySelectorAll('[data-slot="quick-list-bucket"]')].map(
        (el) => el.getAttribute('data-bucket'),
      )
      expect(order[0]).toBe('Needs you')
    })
  })

  describe('empty states', () => {
    it('says there are no tasks, without inventing any', () => {
      renderList({ runs: [] })
      expect(screen.getByText('No tasks yet — describe one.')).not.toBeNull()
      expect(document.querySelectorAll('[data-slot="task-row"]')).toHaveLength(0)
    })
  })
})

describe('TaskQuickListContainer', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  function renderContainer(runs: RunRecord[], route = '/') {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(runs), { status: 200 }))
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[route]}>
          <ListViewProvider>{children}</ListViewProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    return render(<TaskQuickListContainer />, { wrapper })
  }

  it('renders nothing until /api/v1/runs answers — no invented rows, no premature empty state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    renderContainer([])
    expect(screen.queryByText('No tasks yet — describe one.')).toBeNull()
    expect(document.querySelector('[data-slot="quick-list"]')).toBeNull()
  })

  it('renders the live run list', async () => {
    renderContainer([run({ id: 'live', title: 'A real run', status: 'running' })])
    expect(await screen.findByText('A real run')).not.toBeNull()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/runs')
  })

  it('lights the row for the task open at /tasks/:id, including its child routes', async () => {
    renderContainer([run({ id: 'open', title: 'Open one' })], '/tasks/open/changes')
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="task-row"] a[aria-current="page"]')?.getAttribute('href')
      ).toBe('/tasks/open')
    )
  })

  it('stays pinned to active work — the archive is the Tasks page tab, not a rail view', async () => {
    renderContainer([run({ id: 'a', status: 'running' }), run({ id: 'b', status: 'done', archived: true })])

    await waitFor(() => expect(row('a')).not.toBeNull())
    expect(row('b')).toBeNull()
    expect(screen.queryByRole('button', { name: /Archived/ })).toBeNull()
  })
})
