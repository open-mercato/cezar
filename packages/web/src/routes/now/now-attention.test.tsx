import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    expect(needsYou().getAttribute('data-count')).toBe('5')
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
})
