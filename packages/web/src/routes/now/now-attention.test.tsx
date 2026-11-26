import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AttentionItem, RunRecord } from '@open-mercato/cezar-api-client'

import { NowView } from './now'
import type { AttentionActions } from './now-attention'
import { attentionGroups, itemHref, optionAnswer, projectManagerItems } from './now-attention-model'

/** Variant D (spec 2026-11-20-phone-notifications-inbox): Now's Needs you is the attention list. */

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const item = (over: Partial<AttentionItem> & Pick<AttentionItem, 'key' | 'kind' | 'title'>): AttentionItem => ({ since: ago(5), counted: true, ...over })

const ITEMS: AttentionItem[] = [
  item({ key: 'q', kind: 'question', title: 'Which API?', managerId: 'shop', managerName: 'Shop manager', questionKey: 'm:shop:msg1', options: ['REST', 'GraphQL'], header: 'API' }),
  item({ key: 'a', kind: 'approval', title: 'Merge of app#12', managerId: 'notes', managerName: 'Notes manager', actionId: 'act1' }),
  item({ key: 'm', kind: 'message', title: 'Deploy is blocked', managerId: 'shop', managerName: 'Shop manager' }),
  item({ key: 't', kind: 'review', title: 'Bump formula', projectId: 'tap', runId: 'r9' }),
  item({ key: 'f', kind: 'failed', title: 'Flaky test', projectId: 'cezar', runId: 'r8', counted: false }),
]

const waitingRun = {
  id: 'r1', title: 'Fix login', workflow: 'quick-task', task: 't', status: 'waiting', createdAt: ago(60), tokensUsed: 0, archived: false, steps: [],
  waitingSince: ago(3),
} as unknown as RunRecord

function actions(): AttentionActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    answer: vi.fn(async (row, text) => { calls.push(`answer:${row.key}:${text}`) }),
    decide: vi.fn(async (row, decision) => { calls.push(`decide:${row.key}:${decision}`) }),
    markRead: vi.fn(async (row) => { calls.push(`read:${row.key}`) }),
  }
}

function renderNow(props: Partial<ComponentProps<typeof NowView>>) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <Routes>
          <Route path="/p/:projectId/" element={<NowView runs={[waitingRun]} projectName="cezar" now={NOW} onArchiveFinished={vi.fn()} onRetry={vi.fn()} {...props} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const needsYou = () => document.querySelector('[data-slot="now-needs-you"]') as HTMLElement
const attentionKeysShown = () => [...needsYou().querySelectorAll('[data-slot="now-attention-row"]')].map((row) => row.getAttribute('data-key'))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Now as the one list', () => {
  it('This project: Now’s own rows plus the items of managers connected to it, counted together', () => {
    renderNow({ attention: { items: ITEMS, total: 4 }, scope: 'project', onScope: vi.fn(), managerConnected: (id) => id === 'shop', attentionActions: actions() })
    expect(attentionKeysShown()).toEqual(['q', 'm'])
    expect(needsYou().querySelectorAll('[data-slot="now-row"]')).toHaveLength(1)
    expect(needsYou().getAttribute('data-count')).toBe('3')
  })

  it('All: every item, managers first and then each project, with the whole count on the switch', () => {
    const onScope = vi.fn()
    renderNow({ attention: { items: ITEMS, total: 4 }, scope: 'all', onScope, projectLabel: (id) => (id === 'tap' ? 'homebrew-tap' : id), attentionActions: actions() })
    const groups = [...needsYou().querySelectorAll('[data-slot="now-attention-group"]')].map((group) => group.querySelector('h3')?.textContent)
    expect(groups).toEqual(['From managers', 'homebrew-tap', 'cezar'])
    expect(attentionKeysShown()).toEqual(['q', 'a', 'm', 't', 'f'])
    // The count is the badge's: the failed task shows, uncounted.
    expect(needsYou().getAttribute('data-count')).toBe('4')
    const scope = within(document.querySelector('[data-slot="now-scope"]') as HTMLElement)
    expect(scope.getByRole('button', { name: 'All 4' })).toBeTruthy()
    fireEvent.click(scope.getByRole('button', { name: 'This project' }))
    expect(onScope).toHaveBeenCalledWith('project')
  })

  it('answers a one-question card in place with the header, and decides an approval', async () => {
    const acts = actions()
    renderNow({ attention: { items: ITEMS, total: 4 }, scope: 'all', onScope: vi.fn(), attentionActions: acts })
    const question = needsYou().querySelector('[data-key="q"]') as HTMLElement
    fireEvent.click(within(question).getByRole('button', { name: 'GraphQL' }))
    const approval = needsYou().querySelector('[data-key="a"]') as HTMLElement
    fireEvent.click(within(approval).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(acts.calls).toEqual(['answer:q:API: GraphQL', 'decide:a:approve']))
  })

  it('Mark all read takes messages, reviews and failures, never a decision', () => {
    const onMarkAllRead = vi.fn()
    renderNow({ attention: { items: ITEMS, total: 4 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), onMarkAllRead })
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(onMarkAllRead.mock.calls[0]?.[0].map((row: AttentionItem) => row.key)).toEqual(['m', 't', 'f'])
  })

  it('without the list, Now keeps its own rows and no switch', () => {
    renderNow({})
    expect(document.querySelector('[data-slot="now-scope"]')).toBeNull()
    expect(needsYou().getAttribute('data-count')).toBe('1')
  })
})

describe('the attention model', () => {
  it('opens each item where it is resolved', () => {
    expect(ITEMS.map(itemHref)).toEqual([
      '/manager/shop#decision-msg1',
      '/manager/approvals',
      '/manager/shop',
      '/p/tap/tasks/r9/changes',
      '/p/cezar/tasks/r8',
    ])
    expect(itemHref(item({ key: 'w', kind: 'task', title: 'w', projectId: 'p', runId: 'r' }))).toBe('/p/p/tasks/r#reply')
  })

  it('groups and scopes without dropping a task row', () => {
    expect(attentionGroups(ITEMS, (id) => id).map((group) => [group.label, group.items.length])).toEqual([['From managers', 3], ['tap', 1], ['cezar', 1]])
    expect(projectManagerItems(ITEMS, () => false)).toEqual([])
    expect(optionAnswer(ITEMS[0]!, 'REST')).toBe('API: REST')
  })
  it('All still lists a failed task when nothing else waits', () => {
    const failed = ITEMS.filter((row) => row.kind === 'failed')
    renderNow({ attention: { items: failed, total: 0 }, scope: 'all', onScope: vi.fn(), attentionActions: actions() })
    expect(attentionKeysShown()).toEqual(['f'])
  })
});

describe('Needs you triage (spec 2026-11-23-needs-you-triage)', () => {
  function triage() {
    return { dismiss: vi.fn(), dismissAll: vi.fn(), snooze: vi.fn(), keep: vi.fn() }
  }

  it('paints a card’s [[pr:…]] marker as a PR chip, never as raw text', () => {
    const chip = item({ key: 'c', kind: 'question', title: 'Earlier reviews of [[pr:cezar/2428]] read nothing. How now?', managerId: 'shop', managerName: 'Shop manager', questionKey: 'm:shop:m2' })
    renderNow({ attention: { items: [chip], total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage(), referenceProjects: [{ id: 'cezar', name: 'cezar' }] })
    const row = needsYou().querySelector('[data-key="c"]') as HTMLElement
    expect(row.textContent).not.toContain('[[pr:')
    expect(row.querySelector('[data-slot="manager-inline-reference"]')?.textContent).toContain('2428')
    // The row link names it in plain words.
    expect(row.querySelector('[data-slot="now-row-link"]')?.getAttribute('aria-label')).toBe('Earlier reviews of #2428 read nothing. How now?')
  })

  it('an answer chip reads a [[pr:…]] marker as #N, and still answers with the label as written', async () => {
    const acts = actions()
    const card = item({ key: 'c', kind: 'question', title: 'Which?', managerId: 'shop', managerName: 'Shop manager', questionKey: 'm:shop:3', options: ['Only [[pr:cezar/2897]]', 'Neither'], header: 'Bumps' })
    renderNow({ attention: { items: [card], total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: acts, triage: triage() })
    const row = needsYou().querySelector('[data-key="c"]') as HTMLElement
    expect(row.textContent).not.toContain('[[pr:')
    fireEvent.click(within(row).getByRole('button', { name: 'Only #2897' }))
    await waitFor(() => expect(acts.calls).toEqual(['answer:c:Bumps: Only [[pr:cezar/2897]]']))
  })

  it('a question’s ✕ dismisses it with its card; the menu offers snooze', async () => {
    const acts = triage()
    renderNow({ attention: { items: ITEMS, total: 4 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: acts })
    const question = needsYou().querySelector('[data-key="q"]') as HTMLElement
    fireEvent.click(within(question).getByRole('button', { name: 'Dismiss and close the question' }))
    expect(acts.dismiss).toHaveBeenCalledWith({ key: 'q', label: 'Which API?', questionKey: 'm:shop:msg1' })
    const review = needsYou().querySelector('[data-key="t"]') as HTMLElement
    fireEvent.click(within(review).getByRole('button', { name: 'Dismiss' }))
    expect(acts.dismiss).toHaveBeenLastCalledWith({ key: 't', label: 'Bump formula', projectId: 'tap', runId: 'r9' })
  })

  it('moves probably-done items into a collapsed group, out of the count, with "Still needs me"', () => {
    const acts = triage()
    const done = item({ key: 'd', kind: 'question', title: 'Old question', managerId: 'shop', managerName: 'Shop manager', questionKey: 'm:shop:d', counted: false, settled: { why: 'work-ended', detail: 'PR #2428 it mentions was merged' } })
    renderNow({ attention: { items: [...ITEMS, done], total: 4 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: acts })
    expect(attentionKeysShown()).toEqual(['q', 'a', 'm', 't', 'f'])
    const group = needsYou().querySelector('[data-slot="now-probably-done"]') as HTMLElement
    expect(group.textContent).toContain('Probably done1')
    fireEvent.click(within(group).getByRole('button', { name: /Probably done/ }))
    const row = group.querySelector('[data-key="d"]') as HTMLElement
    expect(row.querySelector('[data-slot="now-settled"]')?.textContent).toBe('PR #2428 it mentions was merged')
    fireEvent.click(within(row).getByRole('button', { name: 'Still needs me' }))
    expect(acts.keep).toHaveBeenCalledWith({ key: 'd', label: 'Old question', questionKey: 'm:shop:d' })
    fireEvent.click(within(group).getByRole('button', { name: 'Dismiss all' }))
    expect(acts.dismissAll).toHaveBeenCalledWith([{ key: 'd', label: 'Old question', questionKey: 'm:shop:d' }])
  })

  it('This project: a task row borrows its item’s verdict, and a dismissed or pending one leaves', () => {
    const waiting = item({ key: 'task-needs-you:cezar:r1:x', kind: 'task', title: 'Fix login', projectId: 'cezar', runId: 'r1', counted: false, settled: { why: 'pr-merged', detail: 'PR #2317 merged' } })
    renderNow({ attention: { items: [waiting], total: 0 }, scope: 'project', onScope: vi.fn(), attentionActions: actions(), triage: triage(), projectId: 'cezar' })
    expect(needsYou().getAttribute('data-count')).toBe('0')
    const group = needsYou().querySelector('[data-slot="now-probably-done"]') as HTMLElement
    fireEvent.click(within(group).getByRole('button', { name: /Probably done/ }))
    expect(group.querySelector('[data-run-id="r1"] [data-slot="now-settled"]')?.textContent).toBe('PR #2317 merged')
    cleanup()
    // The server leaves a dismissed item out; its override names the run.
    renderNow({ attention: { items: [], total: 0, overrides: [{ key: waiting.key, mode: 'dismiss', at: ago(1), projectId: 'cezar', runId: 'r1' }] }, scope: 'project', onScope: vi.fn(), attentionActions: actions(), triage: triage(), projectId: 'cezar' })
    expect(needsYou().querySelector('[data-run-id="r1"]')).toBeNull()
    expect(needsYou().getAttribute('data-count')).toBe('0')
  })

  it('a manager item’s menu mutes or unmutes that manager and copies its link', async () => {
    const acts = { ...triage(), mute: vi.fn(), copyLink: vi.fn(), managerMuted: (id: string) => id === 'notes' }
    renderNow({ attention: { items: ITEMS, total: 4 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: acts })
    const openMenu = async (key: string) => {
      const row = needsYou().querySelector(`[data-key="${key}"]`) as HTMLElement
      fireEvent.pointerDown(within(row).getByRole('button', { name: 'More actions' }), { button: 0, pointerType: 'mouse' })
      return screen.findByRole('menu')
    }
    fireEvent.click(within(await openMenu('q')).getByRole('menuitem', { name: 'Mute this manager' }))
    expect(acts.mute).toHaveBeenCalledWith({ id: 'shop', name: 'Shop manager' }, true)
    fireEvent.click(within(await openMenu('a')).getByRole('menuitem', { name: 'Unmute this manager' }))
    expect(acts.mute).toHaveBeenLastCalledWith({ id: 'notes', name: 'Notes manager' }, false)
    fireEvent.click(within(await openMenu('q')).getByRole('menuitem', { name: 'Copy link' }))
    expect(acts.copyLink).toHaveBeenCalledWith('/manager/shop#decision-msg1')
    // A task's item has no manager to mute.
    expect(within(await openMenu('t')).queryByRole('menuitem', { name: /mute/i })).toBeNull()
  })

  it('the phone reveals Snooze and Dismiss on a swipe; only a tap acts', () => {
    const acts = triage()
    renderNow({ attention: { items: ITEMS.slice(3, 4), total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: acts })
    const swipe = needsYou().querySelector('[data-slot="now-swipe"]') as HTMLElement
    const surface = swipe.lastElementChild as HTMLElement
    fireEvent.pointerDown(surface, { pointerType: 'touch', clientX: 300, clientY: 10 })
    fireEvent.pointerMove(surface, { pointerType: 'touch', clientX: 100, clientY: 12 })
    fireEvent.pointerUp(surface, { pointerType: 'touch', clientX: 100, clientY: 12 })
    expect(swipe.getAttribute('data-open')).toBe('true')
    expect(acts.dismiss).not.toHaveBeenCalled()
    fireEvent.click(swipe.querySelector('[data-slot="now-swipe-dismiss"]') as HTMLElement)
    expect(acts.dismiss).toHaveBeenCalledWith({ key: 't', label: 'Bump formula', projectId: 'tap', runId: 'r9' })
    expect(swipe.getAttribute('data-open')).toBeNull()
  })
})

describe('Needs you triage, rendered (review test gaps)', () => {
  const triage = () => ({ dismiss: vi.fn(), dismissAll: vi.fn(), snooze: vi.fn(), keep: vi.fn(), finish: vi.fn(), archive: vi.fn(), cancel: vi.fn() })
  const asking = { ...waitingRun, id: 'ask', title: 'Asks', status: 'failed', awaitingAnswerSince: ago(1), finishedAt: ago(1) } as unknown as RunRecord
  const rowIds = () => [...needsYou().querySelectorAll('[data-slot="now-attention-row"], [data-slot="now-row"]')]
    .filter((row) => !row.closest('[data-slot="now-probably-done"]'))
    .map((row) => row.getAttribute('data-key') ?? row.getAttribute('data-run-id'))

  it('This project interleaves manager items and task rows in the server’s order', () => {
    const items = [
      item({ key: 'a', kind: 'approval', title: 'Merge', managerId: 'notes', managerName: 'Notes', actionId: 'x', since: ago(5 * 24 * 60) }),
      item({ key: 'q', kind: 'question', title: 'Which API?', managerId: 'shop', managerName: 'Shop', questionKey: 'm:shop:1', since: ago(5) }),
    ]
    renderNow({ runs: [waitingRun, asking], attention: { items, total: 2, olderAfterDays: 4 }, scope: 'project', onScope: vi.fn(), managerConnected: () => true, attentionActions: actions(), triage: triage(), projectId: 'cezar' })
    // Decisions first; the approval waiting 5 of 4 days drops below the fresh questions; waits last.
    expect(rowIds()).toEqual(['ask', 'q', 'a', 'r1'])
  })

  it('a question whose close failed shows again', () => {
    const q = item({ key: 'question:m:shop:1', kind: 'question', title: 'Which API?', managerId: 'shop', managerName: 'Shop', questionKey: 'm:shop:1' })
    renderNow({ attention: { items: [q], total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage(), pendingQuestions: new Set() })
    expect(attentionKeysShown()).toEqual(['question:m:shop:1'])
    cleanup()
    renderNow({ attention: { items: [q], total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage(), pendingQuestions: new Set(['m:shop:1']) })
    expect(attentionKeysShown()).toEqual([])
  })

  it('offers task actions only for this project’s runs, and Archive only for a settled run', async () => {
    const openMenu = async (selector: string) => {
      const row = needsYou().querySelector(selector) as HTMLElement
      fireEvent.pointerDown(within(row).getByRole('button', { name: 'More actions' }), { button: 0, pointerType: 'mouse' })
      return screen.findByRole('menu')
    }
    const queued = { ...waitingRun, id: 'busy', status: 'queued' } as unknown as RunRecord
    const items = [
      item({ key: 'here', kind: 'review', title: 'Here', projectId: 'cezar', runId: 'r1' }),
      item({ key: 'there', kind: 'review', title: 'There', projectId: 'tap', runId: 'r9' }),
      item({ key: 'queued', kind: 'task', title: 'Busy', projectId: 'cezar', runId: 'busy' }),
    ]
    renderNow({ runs: [waitingRun, queued], attention: { items, total: 3 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage(), projectId: 'cezar' })
    const here = await openMenu('[data-key="here"]')
    expect(within(here).getByRole('menuitem', { name: /Archive task/ })).toBeTruthy()
    expect(within(here).getByRole('menuitem', { name: /Stop task/ })).toBeTruthy()
    fireEvent.keyDown(here, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const there = await openMenu('[data-key="there"]')
    expect(within(there).queryByRole('menuitem', { name: /Archive task|Stop task|Mark done/ })).toBeNull()
    fireEvent.keyDown(there, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const busy = await openMenu('[data-key="queued"]')
    expect(within(busy).queryByRole('menuitem', { name: /Archive task/ })).toBeNull()
  })

  describe('the phone swipe', () => {
    const surfaceOf = (swipe: HTMLElement) => swipe.lastElementChild as HTMLElement
    const drag = (surface: HTMLElement, dx: number, dy: number) => {
      fireEvent.pointerDown(surface, { pointerType: 'touch', clientX: 300, clientY: 100 })
      fireEvent.pointerMove(surface, { pointerType: 'touch', clientX: 300 + dx, clientY: 100 + dy })
      fireEvent.pointerUp(surface, { pointerType: 'touch', clientX: 300 + dx, clientY: 100 + dy })
    }

    it('keeps its buttons out of reach while closed', () => {
      renderNow({ attention: { items: ITEMS.slice(3, 4), total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage() })
      const swipe = needsYou().querySelector('[data-slot="now-swipe"]') as HTMLElement
      const under = swipe.querySelector('[data-slot="now-swipe-actions"]') as HTMLElement
      expect(under.getAttribute('aria-hidden')).toBe('true')
      expect([...under.querySelectorAll('button')].map((button) => button.tabIndex)).toEqual([-1, -1])
    })

    it('ignores a mostly vertical drag (a scroll)', () => {
      renderNow({ attention: { items: ITEMS.slice(3, 4), total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage() })
      const swipe = needsYou().querySelector('[data-slot="now-swipe"]') as HTMLElement
      drag(surfaceOf(swipe), -60, -200)
      expect(swipe.getAttribute('data-open')).toBeNull()
    })

    it('a swipe’s release never follows the row link', () => {
      renderNow({ attention: { items: ITEMS.slice(3, 4), total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage() })
      const swipe = needsYou().querySelector('[data-slot="now-swipe"]') as HTMLElement
      drag(surfaceOf(swipe), -200, 0)
      const link = swipe.querySelector('[data-slot="now-row-link"]') as HTMLElement
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(true)
      expect(swipe.getAttribute('data-open')).toBe('true')
    })

    it('the first row peeks once on a touch screen', () => {
      vi.useFakeTimers()
      localStorage.removeItem('cez.now.swipeHint')
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', media: query, addEventListener: () => {}, removeEventListener: () => {} }))
      try {
        renderNow({ attention: { items: ITEMS.slice(3, 4), total: 1 }, scope: 'all', onScope: vi.fn(), attentionActions: actions(), triage: triage() })
        const surface = surfaceOf(needsYou().querySelector('[data-slot="now-swipe"]') as HTMLElement)
        act(() => { vi.advanceTimersByTime(800) })
        expect(surface.style.transform).toBe('translateX(-56px)')
        act(() => { vi.advanceTimersByTime(800) })
        expect(surface.style.transform).toBe('')
        expect(localStorage.getItem('cez.now.swipeHint')).toBe('1')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

