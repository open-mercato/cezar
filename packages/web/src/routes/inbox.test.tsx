import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProviderStatusResponse, RunRecord, TodoItem } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { InboxRoute, isTodoRunnable, visibleTodos } from './inbox'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

/** The full meta row: age, action, live source task, PR link, suggested skill. */
const TODO_FULL: TodoItem = {
  id: 't1',
  ts: '2026-07-15T08:00:00.000Z',
  taskId: 'run-1',
  summary: 'Open a follow-up PR for the flaky retry test',
  action: 'follow-up',
  prUrl: 'https://github.com/acme/demo/pull/7',
  suggestedSkill: 'om-fix',
}

/** Its source task is NOT in `/api/v1/runs` — the legacy "source task deleted" case. */
const TODO_ORPHAN: TodoItem = {
  id: 't2',
  taskId: 'run-gone',
  summary: 'Rerun the failed checks',
}

/** Already turned into a task: stays in todos.json as the audit trail, never rendered. */
const TODO_STARTED: TodoItem = {
  id: 't3',
  summary: 'Ship the release notes',
  startedTaskId: 'run-5',
}

const TODOS: TodoItem[] = [TODO_FULL, TODO_ORPHAN, TODO_STARTED]

const RUN_1: RunRecord = {
  id: 'run-1',
  title: 'Fix the retry test',
  workflow: 'quick-task',
  task: 'fix it',
  status: 'done',
  createdAt: '2026-07-15T07:00:00.000Z',
  tokensUsed: 10,
  archived: false,
  steps: [],
}

const STARTED_RUN: RunRecord = {
  ...RUN_1,
  id: 'run-9',
  title: 'Follow-up from the inbox',
  status: 'queued',
}

interface SentRequest {
  path: string
  method: string
  /** Parsed request body, or undefined for a bodyless request — a plain Run must stay bodyless. */
  body?: unknown
}

/** Health fixture: `backends` names the runners the host reports as installed (#401). A
 *  single-backend host is the default, which is what the pre-#401 tests assume. `followups`
 *  is on throughout — an inbox-less server (#471) renders the "inbox is off" state and has
 *  no cards at all, which is that feature's own test, not this file's. */
const health = (backends: readonly string[] = ['claude']) => ({
  version: '0.0.0-test',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  forge: null,
  capabilities: { localHandoff: true, followups: true },
  defaultRunner: backends[0] ?? 'claude',
  checks: backends.map((name) => ({ name, available: true })),
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const connectedProviders = (backends: readonly string[]): ProviderStatusResponse => ({
  providers: (['claude', 'codex', 'opencode'] as const).map((provider) => ({
    provider,
    status: backends.includes(provider) ? 'connected' as const : 'not-installed' as const,
    enabled: true,
  })),
})

const PROVIDERS_NONE: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'disconnected', enabled: true },
    { provider: 'codex', status: 'unknown', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

/** Fetch stub in the house style (github.test.tsx): records requests, serves the fixtures,
 *  and lets a test override specific `METHOD path` keys. Stateful like the real server: a
 *  DELETE really removes the entry, so the invalidation refetch answers without it. */
function stubFetch(
  overrides: Record<string, () => Response | Promise<Response>> = {},
  todos: TodoItem[] = TODOS,
  backends: readonly string[] = ['claude'],
  defaultModels: Record<string, string> = {},
  providers: ProviderStatusResponse = connectedProviders(backends),
): SentRequest[] {
  const sent: SentRequest[] = []
  let inbox = [...todos]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({
        path,
        method,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/todos') return jsonResponse(inbox)
      if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([RUN_1])
      // The runner/model pills (#401) read the host's backends and the per-runner defaults.
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health(backends))
      if (method === 'GET' && path === '/api/v1/providers/status') return jsonResponse(providers)
      if (method === 'GET' && path === '/api/v1/models?runner=codex') return jsonResponse({ runner: 'codex', models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }], source: 'live', stale: false })
      if (method === 'GET' && path === '/api/v1/config') {
        return jsonResponse({ defaultRunner: backends[0] ?? 'claude', defaultModels })
      }
      if (method === 'DELETE' && path.startsWith('/api/v1/todos/')) {
        const id = path.slice('/api/v1/todos/'.length)
        inbox = inbox.filter((item) => item.id !== id)
        return jsonResponse({ removed: true })
      }
      if (method === 'POST' && path.endsWith('/start')) {
        const id = path.slice('/api/v1/todos/'.length, -'/start'.length)
        if (!inbox.some((item) => item.id === id)) return jsonResponse({ error: 'not found' }, 404)
        inbox = inbox.map((item) =>
          item.id === id ? { ...item, startedTaskId: STARTED_RUN.id } : item,
        )
        return jsonResponse({ run: STARTED_RUN }, 201)
      }
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

/** The Run POST the card actually sent — the assertion the #401 tests below turn on. */
const startBody = (sent: readonly SentRequest[], id: string): unknown =>
  sent.find((r) => r.method === 'POST' && r.path === `/api/v1/todos/${id}/start`)?.body

/** Open a pill's dropdown and choose an option by its visible label (the house pattern:
 *  Radix opens on pointerDown, and the menu renders in a portal outside the card). Scoped by
 *  card, because every runnable card carries its own pair. */
async function pick(card: HTMLElement, slot: string, label: string) {
  fireEvent.pointerDown(card.querySelector(`[data-slot="${slot}"]`)!)
  // A discovery runner's options arrive with its catalog (#794), so wait for the labelled
  // option rather than merely for the menu to open.
  let option: HTMLElement | undefined
  await waitFor(() => {
    option = screen.getAllByRole('menuitemradio').find((o) => o.textContent?.includes(label))
    expect(option).toBeDefined()
  })
  fireEvent.click(option as HTMLElement)
}

function renderInbox(entry = '/inbox') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/inbox" element={<InboxRoute />} />
          <Route path="/p/:projectId/inbox" element={<InboxRoute />} />
          {/* Navigation probe: where Run's success is supposed to land (legacy selectRun hop). */}
          <Route path="/tasks/:id" element={<div data-slot="thread-probe" />} />
          <Route path="/p/:projectId/tasks/:id" element={<div data-slot="thread-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="todo-card"]')]
const waitForRunnable = (card: HTMLElement = cards()[0]!) =>
  waitFor(() =>
    expect(card.querySelector<HTMLButtonElement>('[data-action="todo-run"]')?.disabled).toBe(false),
  )

// ---- the visibility rule ----------------------------------------------------------------------

describe('visibleTodos', () => {
  it('hides entries already turned into a task (the legacy audit-trail rule)', () => {
    expect(visibleTodos(TODOS).map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

describe('isTodoRunnable', () => {
  it('infers legacy entries from their executable suggestion', () => {
    expect(isTodoRunnable(TODO_FULL)).toBe(true)
    expect(isTodoRunnable(TODO_ORPHAN)).toBe(false)
  })

  it('lets explicit intent override inference in either direction', () => {
    expect(isTodoRunnable({ ...TODO_FULL, runnable: false })).toBe(false)
    expect(isTodoRunnable({ ...TODO_ORPHAN, runnable: true })).toBe(true)
  })
})

// ---- cards ------------------------------------------------------------------------------------

describe('the inbox card list', () => {
  it('renders one card per visible entry, started entries excluded', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(cards().map((card) => card.dataset.id)).toEqual(['t1', 't2'])
    expect(screen.queryByText('Ship the release notes')).toBeNull()
  })

  it('a full card carries summary, meta, PR link, skill and a live source-task link', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    expect(card.querySelector('[data-slot="todo-summary"]')?.textContent).toBe(TODO_FULL.summary)
    expect(card.querySelector('[data-slot="todo-meta"]')?.textContent).toContain('follow-up')
    expect(card.querySelector('[data-slot="todo-skill"]')?.textContent).toBe('skill: om-fix')
    const pr = card.querySelector<HTMLAnchorElement>('[data-slot="todo-pr"]')
    expect(pr?.getAttribute('href')).toBe(TODO_FULL.prUrl)
    expect(pr?.getAttribute('rel')).toContain('noopener')
    // run-1 exists in /api/v1/runs → a real link into the thread.
    expect(card.querySelector('[data-slot="todo-source"]')?.getAttribute('href')).toBe('/tasks/run-1')
  })

  it('says "source task deleted" when the source run is gone (legacy honesty rule)', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[1]!
    expect(card.querySelector('[data-slot="todo-source"]')).toBeNull()
    expect(card.querySelector('[data-slot="todo-source-gone"]')?.textContent).toBe(
      'source task deleted',
    )
  })

  it('every card wears the attention grammar\'s "needs you" dot — amber, pulsing', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    for (const card of cards()) {
      const dot = card.querySelector<HTMLElement>('[data-slot="status-dot"]')
      expect(dot?.dataset.tone).toBe('pending')
      expect(dot?.className).toContain('animate-pulse')
      expect(dot?.getAttribute('title')).toBe('needs you')
    }
  })
})

// ---- Run --------------------------------------------------------------------------------------

describe('Run', () => {
  it('POSTs the legacy start endpoint and navigates to the new task', async () => {
    const sent = stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    await waitForRunnable()
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="thread-probe"]')).not.toBeNull(),
    )
    expect(sent).toContainEqual({ path: '/api/v1/todos/t1/start', method: 'POST' })
  })

  it('surfaces a start failure as a toast and stays on the inbox', async () => {
    stubFetch({
      'POST /api/v1/todos/t1/start': () => jsonResponse({ error: 'already started' }, 409),
    })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    await waitForRunnable()
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)

    // The server's own words, verbatim (ApiError rule).
    expect(await screen.findByText('already started')).not.toBeNull()
    expect(document.querySelector('[data-slot="thread-probe"]')).toBeNull()
    expect(cards()).toHaveLength(2)
  })
})

// ---- Run: the runner/model pills (#401) -------------------------------------------------------

describe('Run — backend selection (#401)', () => {
  it('an untouched card starts on the host default: no pills touched, no body sent', async () => {
    const sent = stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)

    await waitFor(() => expect(startBody(sent, 't1')).toBeUndefined())
  })

  it('uses project config while boot health is pending', async () => {
    const sent = stubFetch({
      'GET /api/v1/health': () => new Promise<Response>(() => {}),
    })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const run = cards()[0]!.querySelector<HTMLButtonElement>('[data-action="todo-run"]')!
    await waitFor(() => expect(run.disabled).toBe(false))
    fireEvent.click(run)

    await waitFor(() => expect(startBody(sent, 't1')).toBeUndefined())
  })

  it('an untouched card honors Settings → Agents defaultModels — the one real behavior change', async () => {
    // Pre-#401 the Inbox ignored `defaultModels` (it is a client-side preference the server
    // never reads), so a Run always went out bare. Now the card resolves it like the composer
    // does: an untouched card on a host with a configured default sends that model. This is
    // the intended consequence of "cannot drift from the composer" — pinned so it stays a
    // decision rather than an accident.
    const sent = stubFetch({}, TODOS, ['claude'], { claude: 'opus' })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    await waitFor(() => expect(card.querySelector('[data-slot="model-pill"]')?.textContent).toContain('opus'))
    fireEvent.click(card.querySelector('[data-action="todo-run"]')!)

    await waitFor(() => expect(startBody(sent, 't1')).toEqual({ model: 'opus' }))
  })

  it('a single-backend host hides the runner pill but still offers the model (composer rule)', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    await waitFor(() => expect(card.querySelector('[data-slot="model-pill"]')).not.toBeNull())
    expect(card.querySelector('[data-slot="runner-pill"]')).toBeNull()
  })

  /**
   * The Inbox mounts `EnginePills` WITHOUT `accounts` on purpose: `POST /todos/:id/start` has no
   * `agentProfile` field, so offering a login picker here would render a choice the server drops
   * on the floor. That opt-in is the whole safety argument for putting accounts in the shared
   * component, and it needs a host that actually HAS a second login to mean anything — with an
   * empty profiles payload this passes no matter which way the flag is set.
   */
  it('never offers agent accounts, even on a host with two logins for one runner', async () => {
    const twoLogins = (provider: string, id: string, label: string) => ({
      id,
      provider,
      label,
      configDir: `~/.${provider}-${id}`,
      path: `/home/u/.${provider}-${id}`,
      exists: true,
      looksValid: true,
      isDefault: id === 'default',
    })
    const sent = stubFetch({
      'GET /api/v1/workspace/agent-profiles': () =>
        jsonResponse({
          editable: true,
          profiles: [
            twoLogins('claude', 'default', 'Default'),
            twoLogins('claude', 'klaudiusz', 'Klaudiusz'),
          ],
          profileCapableProviders: ['claude'],
          selections: {},
          defaults: {},
        }),
    })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    await waitFor(() => expect(card.querySelector('[data-slot="model-pill"]')).not.toBeNull())
    // A second login would raise the pill on an accounts-enabled surface; here it must not.
    expect(card.querySelector('[data-slot="runner-pill"]')).toBeNull()

    fireEvent.click(card.querySelector('[data-action="todo-run"]')!)
    // No body at all — stronger than an empty one, and the same bar the untouched-pick test above
    // holds the card to. An `agentProfile` the endpoint ignores could not survive this.
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/todos/t1/start')).toBe(true),
    )
    expect(startBody(sent, 't1')).toBeUndefined()
  })

  it('a multi-backend host offers the runner pill, and the pick reaches the POST', async () => {
    const sent = stubFetch({
      // Reproduce a non-boot project whose default is Claude while boot health says Codex.
      'GET /api/v1/health': () => jsonResponse({ ...health(['claude', 'codex']), defaultRunner: 'codex' }),
      'GET /api/v1/config': () => jsonResponse({ defaultRunner: 'claude', defaultModels: {} }),
    }, TODOS, ['claude', 'codex'])
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    await waitFor(() => expect(card.querySelector('[data-slot="runner-pill"]')).not.toBeNull())

    await pick(card, 'runner-pill', 'codex')
    fireEvent.click(card.querySelector('[data-action="todo-run"]')!)

    await waitFor(() => expect(startBody(sent, 't1')).toEqual({ runner: 'codex' }))
  })

  it('a model pick rides along with the runner', async () => {
    const sent = stubFetch({}, TODOS, ['claude', 'codex'])
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    await waitFor(() => expect(card.querySelector('[data-slot="runner-pill"]')).not.toBeNull())

    await pick(card, 'runner-pill', 'codex')
    await pick(card, 'model-pill', 'gpt-future')
    fireEvent.click(card.querySelector('[data-action="todo-run"]')!)

    await waitFor(() =>
      expect(startBody(sent, 't1')).toEqual({ runner: 'codex', model: 'gpt-future' }),
    )
  })

  it('the pick is per card — aiming one entry never re-aims the next', async () => {
    const second: TodoItem = { ...TODO_FULL, id: 't9', summary: 'A second runnable follow-up' }
    const sent = stubFetch({}, [TODO_FULL, second], ['claude', 'codex'])
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const [first, next] = cards() as [HTMLElement, HTMLElement]
    await waitFor(() => expect(first.querySelector('[data-slot="runner-pill"]')).not.toBeNull())

    await pick(first, 'runner-pill', 'codex')
    // The untouched card still shows the host default, and starts on it.
    expect(next.querySelector('[data-slot="runner-pill"]')?.textContent).toContain('claude')

    fireEvent.click(next.querySelector('[data-action="todo-run"]')!)
    await waitFor(() => expect(startBody(sent, 't9')).toBeUndefined())
  })

  it('a non-runnable note gets no pills — there is no run to aim', async () => {
    stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const note = cards()[1]!
    expect(note.querySelector('[data-slot="todo-engine"]')).toBeNull()
    expect(note.querySelector('[data-slot="model-pill"]')).toBeNull()
  })

  it('keeps agent actions unavailable with no connected provider while non-agent actions remain enabled', async () => {
    const sent = stubFetch(
      { 'GET /api/v1/providers/status': () => jsonResponse(PROVIDERS_NONE) },
    )
    renderInbox('/p/acme/inbox')

    await waitFor(() => expect(cards()).toHaveLength(2))
    const runnable = cards()[0]!
    const note = cards()[1]!
    const run = runnable.querySelector<HTMLButtonElement>('[data-action="todo-run"]')!
    const dismiss = runnable.querySelector<HTMLButtonElement>('[data-action="todo-dismiss"]')!
    const acknowledge = note.querySelector<HTMLButtonElement>('[data-action="todo-acknowledge"]')!

    await waitFor(() => expect(run.disabled).toBe(true))
    expect(dismiss.disabled).toBe(false)
    expect(acknowledge.disabled).toBe(false)
    expect(runnable.querySelector<HTMLButtonElement>('[data-slot="model-pill"]')?.disabled).toBe(
      true,
    )
    expect(screen.getAllByRole('link', { name: 'Configure providers' })[0]?.getAttribute('href')).toBe(
      '/p/acme/settings/agents#providers',
    )

    // Defense in depth: bypass the DOM's disabled affordance and make the React handler fire.
    run.removeAttribute('disabled')
    fireEvent.click(run)
    await act(() => Promise.resolve())
    expect(sent.some((request) => request.method === 'POST')).toBe(false)
  })

  it('describes a provider route error as failed verification, not disconnection', async () => {
    stubFetch({
      'GET /api/v1/providers/status': () =>
        jsonResponse({ error: 'provider probe failed' }, 404),
    })
    renderInbox()

    expect(await screen.findByText('Provider authentication could not be verified.')).toBeTruthy()
    expect(document.body.textContent).not.toContain('No agent provider is connected')
    expect(screen.getAllByRole('link', { name: 'Configure providers' }).length).toBeGreaterThan(0)
  })

  it('explicitly sends the sole connected fallback when it differs from the server default', async () => {
    const sent = stubFetch(
      {},
      TODOS,
      ['claude'],
      {},
      {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    )
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    await waitFor(() =>
      expect(card.querySelector<HTMLButtonElement>('[data-action="todo-run"]')?.disabled).toBe(
        false,
      ),
    )
    expect(card.querySelector('[data-slot="runner-pill"]')).toBeNull()
    fireEvent.click(card.querySelector('[data-action="todo-run"]')!)

    await waitFor(() => expect(startBody(sent, 't1')).toEqual({ runner: 'codex' }))
  })

  it('excludes a connected disabled default runner and sends the enabled fallback', async () => {
    const sent = stubFetch(
      {},
      TODOS,
      ['claude', 'codex'],
      {},
      {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    )
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const card = cards()[0]!
    const run = card.querySelector<HTMLButtonElement>('[data-action="todo-run"]')!
    await waitFor(() => expect(run.disabled).toBe(false))
    expect(card.querySelector('[data-slot="runner-pill"]')).toBeNull()

    fireEvent.click(run)

    await waitFor(() => expect(startBody(sent, 't1')).toEqual({ runner: 'codex' }))
  })
})

// ---- Acknowledge ------------------------------------------------------------------------------

describe('Acknowledge', () => {
  it('replaces Run for a note and DELETEs it without starting a task', async () => {
    const sent = stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    const note = cards()[1]!
    expect(note.querySelector('[data-action="todo-run"]')).toBeNull()
    expect(note.querySelector('[data-action="todo-dismiss"]')).toBeNull()
    expect(note.querySelector('[data-action="todo-acknowledge"]')?.textContent).toContain(
      'Acknowledge',
    )

    fireEvent.click(note.querySelector('[data-action="todo-acknowledge"]')!)

    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(sent).toContainEqual({ path: '/api/v1/todos/t2', method: 'DELETE' })
    expect(sent).not.toContainEqual({ path: '/api/v1/todos/t2/start', method: 'POST' })
  })
})

// ---- Dismiss ----------------------------------------------------------------------------------

describe('Dismiss', () => {
  it('DELETEs the entry and drops the card without waiting for SSE', async () => {
    const sent = stubFetch()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-dismiss"]')!)

    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(cards()[0]!.dataset.id).toBe('t2')
    expect(sent).toContainEqual({ path: '/api/v1/todos/t1', method: 'DELETE' })
  })

  it('surfaces a dismiss failure as a toast and keeps the card', async () => {
    stubFetch({ 'DELETE /api/v1/todos/t1': () => jsonResponse({ error: 'not found' }, 404) })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-dismiss"]')!)

    expect(await screen.findByText('not found')).not.toBeNull()
    expect(cards()).toHaveLength(2)
  })
})

// ---- empty & error ----------------------------------------------------------------------------

describe('empty and error states', () => {
  it('an empty inbox renders the shared CenteredState template', async () => {
    stubFetch({}, [])
    renderInbox()

    const state = await waitFor(() => {
      const found = document.querySelector('[data-slot="centered-state"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(state.getAttribute('data-tone')).toBe('neutral')
    expect(state.textContent).toContain('Inbox empty')
    expect(state.textContent).toContain('follow-up suggestions')
  })

  it('an all-started inbox is an empty inbox — the audit trail is not a card list', async () => {
    stubFetch({}, [TODO_STARTED])
    renderInbox()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="centered-state"]')).not.toBeNull(),
    )
    expect(cards()).toHaveLength(0)
  })

  it('a failed todos fetch renders the danger state with the server error', async () => {
    // 4xx: the client's retry policy treats it as a considered answer, so the state is
    // immediate — no exponential-backoff retry for the test to wait out.
    stubFetch({ 'GET /api/v1/todos': () => jsonResponse({ error: 'disk exploded' }, 400) })
    renderInbox()

    const state = await waitFor(() => {
      const found = document.querySelector('[data-slot="centered-state"][data-tone="danger"]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(state.textContent).toContain('disk exploded')
  })
})

// ---- Add instructions (#413) -------------------------------------------------------------------

describe('Add instructions', () => {
  beforeEach(() => {
    // The template menu is a Popover + cmdk: floating-ui positions with a ResizeObserver, and
    // cmdk scrolls the active item into view. jsdom has neither (same stubs as github.test.tsx).
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    Element.prototype.scrollIntoView = vi.fn()
  })

  interface CapturedRequest {
    path: string
    method: string
    body?: unknown
  }

  /** A dedicated stub (rather than extending `stubFetch`/`SentRequest`) so capturing the POST
   *  body here can't change the shape the OTHER describe blocks assert with `toContainEqual`. */
  function stubFetchCapturingBody(uiState: Record<string, unknown> = {}): CapturedRequest[] {
    const captured: CapturedRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
        captured.push({ path, method, body })
        if (method === 'GET' && path === '/api/v1/todos') return jsonResponse(TODOS)
        if (method === 'GET' && path === '/api/v1/runs') return jsonResponse([RUN_1])
        if (method === 'GET' && path === '/api/v1/ui-state') return jsonResponse(uiState)
        if (method === 'GET' && path === '/api/v1/providers/status') {
          return jsonResponse(connectedProviders(['claude']))
        }
        if (method === 'POST' && path === '/api/v1/todos/t1/start') return jsonResponse({ run: STARTED_RUN }, 201)
        return jsonResponse({ error: 'not found' }, 404)
      }),
    )
    return captured
  }

  async function openInstructions() {
    await waitFor(() => expect(cards()).toHaveLength(2))
    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')!)
  }

  it('is collapsed by default — no textarea until "+ Add instructions" is clicked', async () => {
    stubFetchCapturingBody()
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-input"]')).toBeNull()
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')?.textContent).toContain(
      'Add instructions',
    )

    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')!)
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-input"]')).not.toBeNull()
  })

  it('typed instructions are appended as `prompt` on Run', async () => {
    const sent = stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    const input = cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')!
    fireEvent.change(input, { target: { value: 'Also add a regression test.' } })

    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="thread-probe"]')).not.toBeNull())

    const posted = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/todos/t1/start')
    expect(posted?.body).toEqual({
      runner: 'claude',
      prompt: 'Also add a regression test.',
    })
  })

  it('leaving instructions empty sends only the cold-load-safe runner', async () => {
    const sent = stubFetchCapturingBody()
    renderInbox()
    await waitFor(() => expect(cards()).toHaveLength(2))
    await waitForRunnable()

    fireEvent.click(cards()[0]!.querySelector('[data-action="todo-run"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="thread-probe"]')).not.toBeNull())

    const posted = sent.find((r) => r.method === 'POST' && r.path === '/api/v1/todos/t1/start')
    expect(posted?.body).toEqual({ runner: 'claude' })
  })

  it('an opened composer can be collapsed again, keeping the draft', async () => {
    stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    const input = cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')!
    fireEvent.change(input, { target: { value: 'Keep me.' } })

    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-hide"]')!)
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-input"]')).toBeNull()
    // A collapsed-but-non-empty composer says so — Run still carries the draft.
    expect(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')?.textContent).toContain(
      'added',
    )

    fireEvent.click(cards()[0]!.querySelector('[data-slot="todo-instructions-toggle"]')!)
    expect(
      cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')?.value,
    ).toBe('Keep me.')
  })

  it('the instructions box caps at the 20k the server enforces on `prompt`', async () => {
    stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    expect(
      cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')?.maxLength,
    ).toBe(20_000)
  })

  it('the template menu inserts a built-in snippet into the instructions box', async () => {
    stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    // A Popover + cmdk (matching the skill pickers), so: click, not pointerdown.
    fireEvent.click(cards()[0]!.querySelector('[data-slot="prompt-template-trigger"]')!)
    await waitFor(() => expect(document.querySelector('[data-template="add-tests"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-template="add-tests"]')!)

    await waitFor(() =>
      expect(
        cards()[0]!.querySelector<HTMLTextAreaElement>('[data-slot="todo-instructions-input"]')?.value,
      ).toBe('Also add or update tests covering this change.'),
    )
  })

  it('the template menu is searchable from the Inbox composer too', async () => {
    stubFetchCapturingBody()
    renderInbox()
    await openInstructions()

    fireEvent.click(cards()[0]!.querySelector('[data-slot="prompt-template-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-option"]').length).toBeGreaterThan(1),
    )

    fireEvent.change(screen.getByPlaceholderText('search templates…'), { target: { value: 'docs' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1),
    )
    expect(document.querySelector('[data-template="update-docs"]')).not.toBeNull()
  })
})


// ---- the inbox gate (#471) --------------------------------------------------------------------

/** The health payload the route reads `capabilities.followups` from. Only the fields the route
 *  touches — this is a fixture, not a mirror of the real response. */
const healthResponse = (followups: boolean) =>
  jsonResponse({
    version: '0.0.0-test',
    repoRoot: '/repo',
    repo: null,
    checks: [],
    forge: null,
    capabilities: { localHandoff: true, followups },
  })

describe('the inbox gate (#471)', () => {
  it('says the inbox is off — not "empty" — when the server has it disabled', async () => {
    const sent = stubFetch({ 'GET /api/v1/health': () => healthResponse(false) })
    renderInbox()

    expect(await screen.findByText('The follow-up inbox is off')).toBeTruthy()
    // The distinction matters: "Inbox empty" would blame the agents for a switched-off feature.
    expect(screen.queryByText('Inbox empty')).toBeNull()
    // And it tells the user how to get it back.
    expect(screen.getByText(/CEZ_FOLLOWUPS=1/)).toBeTruthy()
    const header = document.querySelector('[data-route="inbox"] header')
    expect(header?.textContent).toContain('Disabled for this server; per-task Notes still run.')
    expect(header?.textContent).not.toContain('Follow-ups agents suggested')
    expect(cards()).toHaveLength(0)

    // The query parks once health lands. It may already have fired one speculative request
    // before that — the deliberate trade in `InboxRoute` (an enabled server must not wait on
    // health) — but it must not keep polling an endpoint that can only answer [].
    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/health')).toBe(true))
    const afterGate = sent.filter((r) => r.path === '/api/v1/todos').length
    expect(afterGate).toBeLessThanOrEqual(1)
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(sent.filter((r) => r.path === '/api/v1/todos')).toHaveLength(afterGate)
  })

  it('renders the real inbox once the server reports the capability', async () => {
    stubFetch({ 'GET /api/v1/health': () => healthResponse(true) })
    renderInbox()

    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(screen.queryByText('The follow-up inbox is off')).toBeNull()
  })

  it('never flashes "Inbox empty" before health says the inbox is off', async () => {
    // An inbox-less server answers [] too, so the empty state must wait for health — otherwise
    // the route flashes exactly the lie it exists to avoid, then corrects itself.
    let releaseHealth = () => {}
    const healthPending = new Promise<void>((resolve) => {
      releaseHealth = resolve
    })
    stubFetch({
      'GET /api/v1/health': () => healthResponse(false),
      'GET /api/v1/todos': () => jsonResponse([]),
    })
    // Re-stub health as a deferred answer so the todos query can settle first.
    const realFetch = globalThis.fetch as unknown as (i: RequestInfo | URL, x?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === '/api/v1/health') {
        await healthPending
        return healthResponse(false)
      }
      return realFetch(input, init)
    })

    renderInbox()
    // Todos have answered [] and health has not: the honest answer is to render neither state.
    await waitFor(() => expect(cards()).toHaveLength(0))
    expect(screen.queryByText('Inbox empty')).toBeNull()

    act(() => releaseHealth())
    expect(await screen.findByText('The follow-up inbox is off')).toBeTruthy()
    expect(screen.queryByText('Inbox empty')).toBeNull()
  })

  it('does not park the list while health is still unknown', async () => {
    // health never answers 200 here (the stub 404s it) — an enabled server must not have its
    // inbox held hostage by a request the list does not depend on.
    stubFetch()
    renderInbox()
    await waitFor(() => expect(cards()).toHaveLength(2))
    expect(screen.queryByText('The follow-up inbox is off')).toBeNull()
  })
})
