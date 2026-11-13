import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { managerKeys } from '@/api/managers'
import { queryKeys } from '@/api/queries'
import { HEADS_LATER_KEY, HEADS_SEEN_KEY } from '@/lib/manager-heads'
import { MANAGER_HEADS_STORAGE_KEY, writeManagerHeadsEnabled } from '@/lib/manager-heads-pref'
import { managerFixture } from '@/routes/manager/manager-fixtures'
import type { ManagerSummary } from '@open-mercato/cezar-api-client'

import { HEAD_FOLD_MS, ManagerHeads } from './manager-heads'

const scout = (overrides: Partial<ManagerSummary> = {}) => managerFixture({
  id: 'scout',
  name: 'Scout',
  mascot: 'scout',
  projects: ['cezar'],
  connectedProjectIds: ['cezar'],
  lastActivityAt: '2026-11-13T10:00:00.000Z',
  preview: 'CI is green on #2081. Merge it with squash?',
  unread: 2,
  pendingActions: 1,
  ...overrides,
})

const release = (overrides: Partial<ManagerSummary> = {}) => managerFixture({
  id: 'release',
  name: 'Release watch',
  lastActivityAt: '2026-11-13T09:00:00.000Z',
  preview: 'Tagged v0.20.0',
  headline: 'Tagged v0.20.0, notes drafted',
  unread: 1,
  important: 1,
  ...overrides,
})

function Where() {
  const { pathname } = useLocation()
  return <output data-testid="where">{pathname}</output>
}

let client: QueryClient

function mount(managers: ManagerSummary[], { path = '/p/default/tasks/run-1', managersOn = true } = {}) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.health, { bootProject: 'cezar', capabilities: { managers: managersOn } })
  client.setQueryData(managerKeys.list, { managers })
  client.setQueryData(['workspace', 'projects'], { projects: [{ id: 'cezar', name: 'cezar' }] })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ManagerHeads />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const update = (managers: ManagerSummary[]) => act(async () => {
  client.setQueryData(managerKeys.list, { managers })
  // The query cache notifies its observers on a timeout, not synchronously.
  await new Promise((resolve) => setTimeout(resolve, 0))
})
const heads = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="manager-head"]')]
const bubble = () => document.querySelector('[data-slot="manager-head-bubble"]')
const announcer = () => document.querySelector('[data-slot="manager-heads-announcer"]')?.textContent ?? ''

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.removeItem(MANAGER_HEADS_STORAGE_KEY)
  document.querySelectorAll('[data-test-extra]').forEach((node) => node.remove())
})

describe('ManagerHeads: when a head appears', () => {
  it('a new approval arrives with its bubble: name · project, the kind, the line, Open chat, Later, ⌥M', () => {
    mount([scout()])
    expect(heads()).toHaveLength(1)
    const head = heads()[0]!
    expect(head.getAttribute('aria-label')).toBe('Scout needs an approval')
    expect(head.querySelector('[data-slot="manager-head-badge"]')?.className).toContain('bg-info')
    const card = bubble()!
    expect(card.textContent).toContain('Scout')
    expect(card.textContent).toContain('· cezar')
    expect(card.querySelector('[data-slot="manager-head-kind"]')?.textContent).toBe('Approval')
    expect(card.querySelector('[data-slot="manager-head-line"]')?.textContent).toBe('CI is green on #2081. Merge it with squash?')
    // Needs-you heads land on the waiting card, not the bottom of the chat.
    expect(card.querySelector('[data-slot="manager-head-open"]')?.getAttribute('href')).toBe('/manager/scout#needs-you')
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy()
    expect(card.querySelector('[data-slot="kbd"]')?.textContent).toMatch(/M$/)
  })

  it('a question says Question', () => {
    mount([scout({ pendingActions: 0, pendingQuestions: 1 })])
    expect(bubble()?.querySelector('[data-slot="manager-head-kind"]')?.textContent).toBe('Question')
  })

  it('news (an important reply) rests as an avatar with a violet badge and no bubble', () => {
    mount([release()])
    expect(heads()).toHaveLength(1)
    expect(heads()[0]!.querySelector('[data-slot="manager-head-badge"]')?.className).toContain('bg-violet')
    expect(bubble()).toBeNull()
    expect(announcer()).toBe('Release watch has news: Tagged v0.20.0, notes drafted')
  })

  it('a routine message never surfaces', () => {
    mount([release({ important: 0, headline: undefined, unread: 3 })])
    expect(heads()).toHaveLength(0)
    expect(document.querySelector('[data-slot="manager-head-pill"]')).toBeNull()
  })

  it('announces each arrival once, politely, and a reload does not announce or speak again', () => {
    const view = mount([scout()])
    const region = document.querySelector('[data-slot="manager-heads-announcer"]')!
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(announcer()).toBe('Scout asks for an approval: CI is green on #2081. Merge it with squash?')
    view.unmount()
    mount([scout()])
    expect(announcer()).toBe('')
    expect(bubble()).toBeNull()
    expect(heads()).toHaveLength(1)
  })
})

describe('ManagerHeads: folding and resting', () => {
  it('folds the bubble back to the avatar after 8 s, but not while hovered', () => {
    vi.useFakeTimers()
    mount([scout()])
    expect(bubble()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(HEAD_FOLD_MS - 1) })
    expect(bubble()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(bubble()).toBeNull()
    expect(heads()).toHaveLength(1)

    const row = document.querySelector('[data-slot="manager-head-row"]')!
    fireEvent.mouseEnter(row)
    expect(bubble()).not.toBeNull()
    act(() => { vi.advanceTimersByTime(HEAD_FOLD_MS * 2) })
    expect(bubble()).not.toBeNull()
    fireEvent.mouseLeave(row)
    expect(bubble()).toBeNull()
  })

  it('stays open past 8 s while focus is inside it', () => {
    vi.useFakeTimers()
    mount([scout()])
    act(() => heads()[0]!.focus())
    act(() => { vi.advanceTimersByTime(HEAD_FOLD_MS + 1) })
    expect(bubble()).not.toBeNull()
  })

  it('more than two collapse into "+N", newest at the bottom and largest', () => {
    mount([
      release(),
      scout(),
      managerFixture({ id: 'deps', name: 'Dependabot sweeper', unread: 1, pendingQuestions: 1, lastActivityAt: '2026-11-13T08:00:00.000Z' }),
    ])
    expect(heads().map((head) => head.getAttribute('aria-label'))).toEqual(['Release watch has news', 'Scout needs an approval'])
    expect(heads()[1]!.className).toContain('size-11')
    expect(heads()[0]!.className).toContain('size-9')
    const more = document.querySelector('[data-slot="manager-heads-more"]')!
    expect(more.textContent).toBe('+1')
    expect(more.getAttribute('aria-label')).toBe('1 more manager waiting')
  })
})

describe('ManagerHeads: when it leaves', () => {
  it('Later hides that manager until it posts something new', async () => {
    mount([scout()])
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(heads()).toHaveLength(0)
    expect(JSON.parse(sessionStorage.getItem(HEADS_LATER_KEY)!)).toEqual({ scout: 1 })

    await update([scout({ preview: 'Still waiting', unread: 3 })])
    expect(heads()).toHaveLength(0)

    await update([scout({ pendingActions: 2, preview: 'Also merge #2090?' })])
    expect(heads()).toHaveLength(1)
    expect(bubble()?.textContent).toContain('Also merge #2090?')
  })

  it('opening the chat from the bubble removes the head and lands on the chat', () => {
    mount([scout()])
    fireEvent.click(document.querySelector('[data-slot="manager-head-open"]')!)
    expect(screen.getByTestId('where').textContent).toBe('/manager/scout')
    expect(heads()).toHaveLength(0)
  })

  it('a chat opened anywhere (unread cleared) or a request answered removes it', async () => {
    mount([scout(), release()])
    expect(heads()).toHaveLength(2)
    await update([scout({ unread: 0 }), release()])
    expect(heads().map((head) => head.getAttribute('aria-label'))).toEqual(['Release watch has news'])
    await update([scout({ unread: 0 }), release({ important: 0, unread: 0 })])
    expect(heads()).toHaveLength(0)
  })

  it('never leaves on a timer', () => {
    vi.useFakeTimers()
    mount([scout()])
    act(() => { vi.advanceTimersByTime(60 * 60_000) })
    expect(heads()).toHaveLength(1)
  })
})

describe('ManagerHeads: where it never shows', () => {
  it('on any manager route', () => {
    mount([scout()], { path: '/manager/other' })
    expect(heads()).toHaveLength(0)
    expect(document.querySelector('[data-slot="manager-heads-announcer"]')).toBeNull()
    // Nothing was marked as shown, so it still arrives once back in task mode.
    expect(sessionStorage.getItem(HEADS_SEEN_KEY)).toBeNull()
  })

  it('when the pop-ups are switched off, live', () => {
    mount([scout()])
    expect(heads()).toHaveLength(1)
    act(() => writeManagerHeadsEnabled(false))
    expect(heads()).toHaveLength(0)
  })

  it('when managers are unavailable', () => {
    mount([scout()], { managersOn: false })
    expect(heads()).toHaveLength(0)
  })

  it('while a dialog or the palette is open', async () => {
    mount([scout()])
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    dialog.setAttribute('data-test-extra', '')
    await act(async () => { document.body.append(dialog) })
    expect(heads()).toHaveLength(0)
    await act(async () => { dialog.setAttribute('data-state', 'closed') })
    expect(heads()).toHaveLength(1)
  })
})

describe('ManagerHeads: keyboard, placement and phone', () => {
  it('⌥M focuses the newest head, which links to the chat; Esc folds the bubble', () => {
    mount([release(), scout()])
    fireEvent.keyDown(window, { key: 'µ', code: 'KeyM', altKey: true })
    const newest = heads().at(-1)!
    expect(document.activeElement).toBe(newest)
    expect(newest.getAttribute('href')).toBe('/manager/scout#needs-you')
    expect(bubble()).not.toBeNull()
    fireEvent.keyDown(newest, { key: 'Escape' })
    expect(bubble()).toBeNull()
    expect(document.activeElement).toBe(newest)
  })

  it('sits 12px above the composer dock, measured, and 16px from the content edge', async () => {
    const dock = document.createElement('div')
    dock.setAttribute('data-slot', 'thread-dock')
    dock.setAttribute('data-test-extra', '')
    dock.getBoundingClientRect = () => ({ top: 600, bottom: 768, left: 240, right: 1000, width: 760, height: 168, x: 240, y: 600, toJSON: () => ({}) })
    document.body.append(dock)
    mount([scout()])
    const stack = document.querySelector<HTMLElement>('[data-slot="manager-heads"]')!
    expect(stack.style.bottom).toBe(`${window.innerHeight - 600 + 12}px`)
    expect(stack.style.right).toContain(`${window.innerWidth - 1000 + 16}px`)

    await act(async () => { dock.remove() })
    expect(stack.style.bottom).toContain('16px')
  })

  it('on a phone the pill sits above the floating New task button, never over it', () => {
    const fab = document.createElement('a')
    fab.setAttribute('data-slot', 'new-task-fab')
    fab.setAttribute('data-test-extra', '')
    fab.getBoundingClientRect = () => ({ top: 700, bottom: 756, left: 300, right: 356, width: 56, height: 56, x: 300, y: 700, toJSON: () => ({}) })
    document.body.append(fab)
    mount([scout()])
    const pill = document.querySelector<HTMLElement>('[data-slot="manager-head-pill"]')!
    expect(pill.style.bottom).toContain(`${window.innerHeight - 700 + 12}px`)
  })

  it('on a phone: one pill that names the manager and opens its chat', () => {
    mount([scout()])
    const pill = document.querySelector<HTMLAnchorElement>('[data-slot="manager-head-pill"]')!
    expect(pill.className).toContain('md:hidden')
    expect(document.querySelector('[data-slot="manager-heads"]')?.className).toContain('max-md:hidden')
    expect(pill.textContent).toBe('Scout needs an approval')
    fireEvent.click(pill)
    expect(screen.getByTestId('where').textContent).toBe('/manager/scout')
  })
})
