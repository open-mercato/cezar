import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeProvider } from '@/api/project-scope-context'
import { queryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type {
  ApiRun,
  HealthResponse,
  ProviderStatusResponse,
  RunEvent,
  RunStatus,
} from '@open-mercato/cezar-api-client'

import { TaskThreadRoute, ThreadView } from './task-thread'
import { buildTranscriptRows, mainTranscriptSections } from './session-transcript'
import { reduceThread } from './thread-state'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** ThreadView now hosts the run header, whose hooks need a query client (mutations, the runs
 *  list) and a router (tabs, delete-navigates-home). Data assertions still drive the reduced
 *  fixture states directly — the providers are plumbing, not fixtures.
 *
 *  `health` is served on `/api/v1/health`: the footer's issue link is synthesized against the
 *  project's own repo remote (#526), so a test that wants one must say which repo this is. */
function renderView(
  ui: ReactElement,
  providerStatus: ProviderStatusResponse = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'not-installed', enabled: true },
      { provider: 'opencode', status: 'not-installed', enabled: true },
    ],
  },
  health: Partial<HealthResponse> = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      const body =
        path === '/api/v1/providers/status' ? providerStatus
        : path === '/api/v1/health' ? health
        : []
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )
  // The client is handed back so a test can await a specific query landing in the cache —
  // the only honest barrier for asserting that something is absent *after* data arrived.
  const queryClient = createQueryClient()
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    ),
    queryClient,
  }
}

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 'do the thing plz',
    titleSummary: 'Do the thing',
    workflow: 'quick-task',
    task: 'Summarize what this project does.',
    status,
    createdAt: '2026-07-14T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }) as ApiRun

const line = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: '2026-07-14T12:00:00.000Z', type, ...rest }) as RunEvent

/** A small real-shaped transcript: dim lines, a v2 message, a tool, a v1 user reply. */
const EVENTS: RunEvent[] = [
  line(1, 'lifecycle', { message: 'run started — workflow "quick-task" (runner: claude)' }),
  line(2, 'note', { message: 'worktree ready — branch cez/r1 (base main)' }),
  line(3, 'turn.started', { turnId: 'turn_1' }),
  line(4, 'item.completed', {
    item: { kind: 'message', id: 'item_1', role: 'assistant', text: 'It is a **cockpit** for agents.' },
  }),
  line(5, 'item.completed', {
    item: { kind: 'tool', id: 'toolu_1', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'completed', output: 'ok' },
  }),
  line(6, 'item.completed', { item: { kind: 'reasoning', id: 'item_2', text: 'Considering the layout…' } }),
  line(7, 'user-message', { text: 'Thanks!', imageCount: 2 }),
]

const transcriptRows = (fixture: ApiRun, thread = reduceThread(EVENTS)) =>
  buildTranscriptRows(mainTranscriptSections(fixture, thread), fixture.id)

describe('ThreadView', () => {
  it('keeps provider authorization recovery visible after the run reaches done', () => {
    const authRequired = [
      line(1, 'provider-auth-required', { provider: 'codex', authFailureId: 'incident-1' }),
      line(2, 'done'),
    ]
    renderView(<ThreadView run={run('done')} thread={reduceThread(authRequired)} />)

    expect(screen.getByRole('alert').textContent).toContain('This run needed Codex authorization')
    expect(screen.getByRole('link', { name: 'Open provider settings' }).getAttribute('href')).toBe(
      '/settings/agents#providers',
    )
  })

  it('an issue-subject closed run links its DISCOVERED issue URL, never the incidental PR (#526)', () => {
    const issueRun = run('done', {
      markerRefs: { issue: 524 },
      referencedIssueUrl: 'https://github.com/o/r/issues/524',
      // An unrelated PR that only appeared in the transcript — it must not surface.
      referencedPullRequestUrl: 'https://github.com/o/r/pull/454',
    })
    renderView(<ThreadView run={issueRun} thread={reduceThread([line(1, 'done')])} />)

    const issueLink = document.querySelector('[data-slot="issue-link"]')
    expect(issueLink?.getAttribute('href')).toBe('https://github.com/o/r/issues/524')
    // Defect B: the incidental PR is not linked in the footer.
    expect(document.querySelector('[data-slot="thread-footer"] [data-slot="pr-link"]')).toBeNull()
  })

  it('renders the task as the leading user bubble and the v1 reply as another', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const bubbles = document.querySelectorAll('[data-slot="user-bubble"]')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]!.textContent).toContain('Summarize what this project does.')
    expect(bubbles[1]!.textContent).toContain('Thanks!')
    expect(bubbles[1]!.textContent).toContain('2 images attached')
  })

  it('turns the screenshot-shaped provisional marker into option cards without exposing JSON', () => {
    const questions = [
      {
        header: 'Who books',
        question: 'Who should be able to create bookings in v1?',
        multiSelect: false,
        options: [
          { label: 'Staff only', description: 'Backend/admin CRUD only for v1' },
          { label: 'Staff + customer self-service', description: 'Also let customers book through the portal' },
        ],
      },
    ]
    const raw = `later:\n\nCEZ:ASK ${JSON.stringify({ questions })}`
    const events = [
      line(1, 'item.completed', {
        item: { kind: 'message', id: 'ask-message', role: 'assistant', text: raw },
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(events, { activeTurn: true })} />)
    expect(document.body.textContent).toContain('later:')
    expect(document.body.textContent).not.toContain('CEZ:ASK')

    cleanup()
    const settled = [...events, line(2, 'ask.requested', { requestId: 'ask-screenshot', questions })]
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(settled)} />)
    expect(document.body.textContent).not.toContain('CEZ:ASK')
    expect(screen.getByText('Staff only')).not.toBeNull()
    expect(screen.getByText('Staff + customer self-service')).not.toBeNull()
  })

  it('renders assistant messages as markdown, not raw text', async () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    // The ** marks became a strong element (Streamdown spells it as a data-tagged span) —
    // the renderer parsed, it didn't echo.
    await waitFor(() => {
      const strong = document.querySelector('[data-slot="assistant-message"] [data-streamdown="strong"]')
      expect(strong?.textContent).toBe('cockpit')
    })
    expect(document.querySelector('[data-slot="assistant-message"]')?.textContent).not.toContain('**')
  })

  it('renders USER messages as markdown too, not raw text (#524)', async () => {
    // A GitHub hand-off prompt is markdown — a `#N` line, a bare link, a `---` rule — so the
    // bubble that echoes it back must parse it, exactly as the assistant side does. Rendering
    // one side raw made the same document look broken going in and fine coming out.
    const events = [
      line(1, 'user-message', { text: 'Fix **now**: see https://github.com/acme/demo/issues/142' }),
    ]
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(events)} />)

    await waitFor(() => {
      const strong = document.querySelector('[data-slot="user-bubble"] [data-streamdown="strong"]')
      expect(strong?.textContent).toBe('now')
    })
    const bubble = [...document.querySelectorAll('[data-slot="user-bubble"]')].at(-1)
    expect(bubble?.textContent).not.toContain('**')
  })

  it('dims lifecycle lines and shows the tool card + folded reasoning', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const notes = [...document.querySelectorAll('[data-slot="note-line"]')]
    expect(notes.map((n) => n.getAttribute('data-tone'))).toEqual(['dim', 'dim'])
    expect(notes[1]!.textContent).toContain('worktree ready')

    const toolCard = document.querySelector('[data-slot="tool-card"]')
    expect(toolCard?.textContent).toContain('Ran')
    expect(toolCard?.textContent).toContain('npm test')
    expect(toolCard?.getAttribute('data-status')).toBe('completed')

    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('Thinking — Considering the layout…')
  })

  it('shows the header title (auto-summary, never the raw title) and the status pill', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Do the thing')
    expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain('needs you')
  })

  it('waiting → the paused hint (pulsing dot) in the dock, right above an ENABLED composer', () => {
    renderView(<ThreadView run={run('waiting')} thread={reduceThread(EVENTS)} />)
    const hint = document.querySelector('[data-slot="thread-dock"] [data-slot="paused-hint"]')
    expect(hint?.textContent).toContain('The agent is paused, waiting for your reply')
    expect(hint?.querySelector('[data-slot="status-dot"]')).not.toBeNull()
    // No body footer for waiting — the dock owns that state now.
    expect(document.querySelector('[data-slot="thread-footer"]')).toBeNull()
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Reply — / for skills, @ for files…')
  })

  it('failed by a usage limit → the dock says when it resumes itself, and links the setting', () => {
    renderView(
      <ThreadView
        run={run('failed', {
          error: 'step "work" failed: Claude AI usage limit reached|1754236800',
          autoResumeAt: '2026-08-03T17:00:30.000Z',
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    const hint = document.querySelector('[data-slot="thread-dock"] [data-slot="auto-resume-hint"]')
    expect(hint?.textContent).toContain('Usage limit reached — this task resumes automatically at')
    // To the SECOND: "6:41 PM" cannot tell a wait that is nearly over from one that just
    // started. Matched as a pattern because the rendered zone is the reader's own.
    expect(hint?.querySelector('time')?.textContent).toMatch(/:\d{2}:30\b/)
    // The absolute instant is the source of truth, not a countdown (spec
    // 2026-08-03-auto-resume-after-usage-limit).
    expect(hint?.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-03T17:00:30.000Z')
    // The other half of an automation nobody opted into: one click to switch it off.
    expect(screen.getByRole('link', { name: 'Auto-resume settings' }).getAttribute('href')).toBe(
      '/settings/global/resources',
    )
  })

  it('offers a per-task opt-out that hits DELETE /auto-resume for THIS run only', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' })
        const body = String(input).endsWith('/auto-resume') ? { cancelled: true } : []
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }),
    )
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView
            run={run('failed', { autoResumeAt: '2026-08-03T17:00:30.000Z' })}
            thread={reduceThread(EVENTS)}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Don’t resume' }))
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/runs/r1/auto-resume'))).toBe(true),
    )
  })

  it('an ordinary failure has no resume hint — the promise is only made when the server armed one', () => {
    renderView(<ThreadView run={run('failed', { error: 'boom' })} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="auto-resume-hint"]')).toBeNull()
  })

  it('running → the composer stays enabled with the "message" placeholder, no paused hint', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="paused-hint"]')).toBeNull()
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Message the agent — / for skills, @ for files…')
  })

  it.each([
    ['disabled', { provider: 'claude', status: 'connected', enabled: false }],
    ['disconnected', { provider: 'claude', status: 'disconnected', enabled: true }],
  ] as const)('keeps a queued Codex prompt authorable when fallback Claude is %s', async (_case, claude) => {
    renderView(
      // Before the run starts, an omitted runner means the server will use its configured
      // default (Codex in the reported case). The active-provider helper used to guess Claude
      // here and block a mutation that invokes no provider at all.
      <ThreadView run={run('queued', { runner: undefined })} thread={reduceThread([])} />,
      {
        providers: [
          claude,
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    )

    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.disabled).toBe(false))
    expect(textarea.placeholder).toBe('Add to the prompt — sent when the run starts…')
    expect(screen.queryByRole('link', { name: 'Configure providers' })).toBeNull()
  })

  it('keeps a waiting composer enabled when a retrying current step uses a usable provider', async () => {
    renderView(
      <ThreadView
        run={run('waiting', {
          runner: 'claude',
          currentStepId: 'retry',
          steps: [{ id: 'retry', name: 'Retry', kind: 'agent', status: 'waiting', iterations: 2, tokensUsed: 0, backend: 'codex' }],
        })}
        thread={reduceThread(EVENTS)}
      />,
      {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    )

    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.disabled).toBe(false))
  })

  it('monitoring → no paused hint, "message" placeholder, and a "monitoring" pill (#490)', () => {
    renderView(<ThreadView run={run('running', { activity: 'monitoring' })} thread={reduceThread(EVENTS)} />)
    // Still working on downstream work, not on you: never the "paused, waiting for your reply" banner.
    expect(document.querySelector('[data-slot="paused-hint"]')).toBeNull()
    expect(document.querySelector('[data-slot="pill"]')?.textContent).toContain('monitoring')
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Message the agent — / for skills, @ for files…')
  })

  /** A closed run with a session to resume is still AUTHORABLE: Continue takes a prompt, so
   *  the composer stays live and its send is that Continue. */
  it('closed but resumable → the composer stays enabled, and sending is Continue', async () => {
    renderView(
      <ThreadView
        run={run('done', {
          steps: [
            { id: 'task', name: 'Do the task', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's-1' },
          ],
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    await waitFor(() => expect(textarea.disabled).toBe(false))
    expect(textarea.placeholder).toBe('Continue — add a prompt, or send to just reopen the session…')
    // Empty is still the one-click Continue, so send is live with nothing typed.
    expect((screen.getByLabelText('Continue') as HTMLButtonElement).disabled).toBe(false)
    // The engine pills ride along, so the prompt and the picked backend go in one request.
    expect(document.querySelector('[data-slot="follow-up-engine"]')).not.toBeNull()
  })

  /** #472 — stacked messages render as their own bubbles, after the task. */
  it('renders one bubble per stacked message, in order, with their images', () => {
    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [
            { id: 'm1', text: 'also update the changelog', createdAt: '2026-07-21T10:00:00.000Z' },
            {
              id: 'm2',
              text: 'and bump the version',
              images: ['/api/v1/runs/r1/images/pasted-1.png'],
              createdAt: '2026-07-21T10:01:00.000Z',
            },
          ],
        })}
        thread={reduceThread([])}
      />,
    )
    const bubbles = [...document.querySelectorAll('[data-slot="user-bubble"]')].map(
      (b) => b.textContent ?? '',
    )
    expect(bubbles[0]).toContain('Summarize what this project does.')
    expect(bubbles[1]).toContain('also update the changelog')
    expect(bubbles[2]).toContain('and bump the version')
    expect(
      document.querySelector('img[src="/api/v1/runs/r1/images/pasted-1.png"]'),
    ).not.toBeNull()
  })

  /**
   * The no-regression assertion, at the row-builder level rather than the DOM:
   * an absent stack and an empty one must produce the same rows, and a run with
   * no stack must produce exactly today's rows. Asserting on the shared row builder's
   * keys keeps this free of Radix's per-render generated ids.
   */
  it('builds the same rows whether the stack is absent or empty', () => {
    const keys = (extra: Partial<ApiRun>) =>
      transcriptRows(run('queued', extra)).map((r) => r.key)

    const absent = keys({})
    expect(absent[0]).toBe('task')
    // No `queued:` row is invented for a run that has none.
    expect(absent.some((k) => k.startsWith('queued:'))).toBe(false)
    expect(keys({ queuedMessages: [] })).toEqual(absent)
  })

  it('inserts the stacked rows directly after the task row, in order', () => {
    const keys = transcriptRows(
      run('queued', {
        queuedMessages: [
          { id: 'm1', text: 'one', createdAt: '2026-07-21T10:00:00.000Z' },
          { id: 'm2', text: 'two', createdAt: '2026-07-21T10:01:00.000Z' },
        ],
      }),
    ).map((r) => r.key)

    expect(keys.slice(0, 3)).toEqual(['task', 'queued:m1', 'queued:m2'])
    // …and the rest of the transcript is untouched behind them.
    expect(keys.slice(3)).toEqual(
      transcriptRows(run('queued')).map((r) => r.key).slice(1),
    )
  })

  /**
   * Review fix: the affordance callbacks are memoized on the mutations' `mutateAsync`
   * functions, not on the mutation RESULT objects — TanStack returns a fresh result object
   * every render, which would rebuild every thread row each time and defeat the memo that
   * exists because these threads get big enough to virtualize.
   *
   * Asserted as the observable consequence: re-rendering with identical inputs neither
   * duplicates nor loses the affordances, and the row builder is pure.
   */
  it('re-renders a queued run without duplicating or losing the affordances', () => {
    const fixture = run('queued', {
      queuedMessages: [{ id: 'm1', text: 'stacked', createdAt: '2026-07-21T10:00:00.000Z' }],
    })
    const thread = reduceThread(EVENTS)

    // The row builder is pure: same inputs, same rows.
    expect(transcriptRows(fixture, thread).map((r) => r.key)).toEqual(
      transcriptRows(fixture, thread).map((r) => r.key),
    )

    const { rerender } = renderView(<ThreadView run={fixture} thread={thread} />)
    expect(screen.getAllByLabelText('Remove message')).toHaveLength(1)
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ThreadView run={fixture} thread={thread} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getAllByLabelText('Remove message')).toHaveLength(1)
    expect(screen.getAllByLabelText('Edit message')).toHaveLength(1)
  })

  /** #472 — the edit/remove affordances exist only while the run is queued. */
  it('offers edit + remove on stacked bubbles and edit-only on the prompt, while queued', () => {
    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'stacked', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    // The prompt is editable but never removable — a run with no prompt is not a run.
    expect(screen.getByLabelText('Edit the prompt')).toBeTruthy()
    expect(screen.getAllByLabelText('Edit message')).toHaveLength(1)
    expect(screen.getAllByLabelText('Remove message')).toHaveLength(1)
  })

  it('renders the bubbles read-only once the run is running', () => {
    renderView(
      <ThreadView
        run={run('running', {
          queuedMessages: [{ id: 'm1', text: 'stacked', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    expect(screen.queryByLabelText('Edit the prompt')).toBeNull()
    expect(screen.queryByLabelText('Edit message')).toBeNull()
    expect(screen.queryByLabelText('Remove message')).toBeNull()
  })

  it('PATCHes the edited text, and Escape cancels without writing', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []

    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'typo here', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    // Stubbed AFTER render: renderView installs its own fetch stub, and the mutations
    // only fire on the clicks below.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        // GET answers `[]`: our own invalidateQueries refetches the runs LIST, and the
        // header's queuePositions would choke on a non-array.
        const body = (init?.method ?? 'GET') === 'GET' ? '[]' : '{}'
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )

    // Escape first: opens the editor, changes the text, cancels — nothing is written.
    fireEvent.click(screen.getAllByLabelText('Edit message')[0]!)
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'discarded' } })
    fireEvent.keyDown(screen.getByLabelText('Edit the message'), { key: 'Escape' })
    expect(screen.queryByLabelText('Edit the message')).toBeNull()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)

    // Then a real edit.
    fireEvent.click(screen.getAllByLabelText('Edit message')[0]!)
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'fixed now' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url).toContain('/queued-messages/m1')
    expect(patch.body).toMatchObject({ text: 'fixed now' })
  })

  it('keeps a failed edit open and surfaces the server error', async () => {
    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'typo here', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(
        new Response(JSON.stringify({ error: 'run already started' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
      )),
    )

    fireEvent.click(screen.getAllByLabelText('Edit message')[0]!)
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'fixed now' } })
    fireEvent.click(screen.getByText('Save'))

    expect((await screen.findByRole('alert')).textContent).toContain('run already started')
    expect((screen.getByLabelText('Edit the message') as HTMLTextAreaElement).value).toBe('fixed now')
  })

  it('DELETEs a removed message', async () => {
    const calls: string[] = []

    renderView(
      <ThreadView
        run={run('queued', {
          queuedMessages: [{ id: 'm1', text: 'remove me', createdAt: '2026-07-21T10:00:00.000Z' }],
        })}
        thread={reduceThread([])}
      />,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'DELETE') calls.push(String(input))
        // GET answers `[]`: our own invalidateQueries refetches the runs LIST, and the
        // header's queuePositions would choke on a non-array.
        const body = (init?.method ?? 'GET') === 'GET' ? '[]' : '{}'
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )
    fireEvent.click(screen.getAllByLabelText('Remove message')[0]!)
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toContain('/queued-messages/m1')
  })

  it('PATCHes the run itself when the initial prompt is edited', async () => {
    const bodies: unknown[] = []

    renderView(<ThreadView run={run('queued')} thread={reduceThread([])} />)
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PATCH' && !String(input).includes('queued-messages')) {
          bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
        }
        // GET answers `[]`: our own invalidateQueries refetches the runs LIST, and the
        // header's queuePositions would choke on a non-array.
        const body = (init?.method ?? 'GET') === 'GET' ? '[]' : '{}'
        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )
    fireEvent.click(screen.getByLabelText('Edit the prompt'))
    fireEvent.change(screen.getByLabelText('Edit the message'), { target: { value: 'a better prompt' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ task: 'a better prompt' })
  })

  /** #472 — a queued run has not started, so its prompt is still authorable. */
  it('queued → the composer is ENABLED with its own placeholder and hint, and no Continue', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread(EVENTS)} />)
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(textarea.placeholder).toBe('Add to the prompt — sent when the run starts…')
    expect(document.querySelector('[data-slot="queued-hint"]')?.textContent).toContain(
      'folded into the prompt before the run starts',
    )
    // Continue is meaningless for a run that has not run, so no engine pills either.
    expect(document.querySelector('[data-slot="follow-up-engine"]')).toBeNull()
  })

  /**
   * The scope boundary: the queued branch is `queued` ONLY, and the composer only stays live
   * on a closed run that HAS a session to resume. This `done` run has none, so it is the one
   * remaining genuinely-disabled state — and it is told so honestly, without offering a
   * Continue it cannot perform.
   */
  it('closed with no resumable session → disabled composer, and no Continue invented', () => {
    renderView(<ThreadView run={run('done')} thread={reduceThread(EVENTS)} />)
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Session closed — no session to resume.')
    expect(document.querySelector('[data-slot="follow-up-engine"]')).toBeNull()
    expect(document.querySelector('[data-slot="queued-hint"]')).toBeNull()
  })

  it('done → the closed footer; failed → the danger footer carrying the run error', () => {
    renderView(<ThreadView run={run('done')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="thread-footer"]')?.textContent).toBe('Session closed')
    cleanup()

    renderView(<ThreadView run={run('failed', { error: 'checks failed' })} thread={reduceThread(EVENTS)} />)
    const footer = document.querySelector('[data-slot="thread-footer"]')
    expect(footer?.textContent).toBe('Session failed — checks failed')
    expect(footer?.className).toContain('text-danger')
  })

  /**
   * #526 at the surface the user actually reported: run `6ab44452` (`om-prepare-issue`) created
   * issue #524, declared `CEZ:ISSUE` and no `CEZ:PR`, and had one incidental PR (#454) scraped
   * out of its duplicate-search output. The footer linked #454 and never linked #524. Asserting
   * on the rendered anchors — not just the helpers — is what makes deleting or miswiring the
   * JSX fail.
   */
  it('an issue-subject closed run SYNTHESIZES its issue link from the project repo (#526)', async () => {
    renderView(
      <ThreadView
        run={run('done', {
          issueNumber: 524,
          markerRefs: { issue: 524 },
          referencedPullRequestUrl: 'https://github.com/open-mercato/cezar/pull/454',
          referencedPrCandidates: ['https://github.com/open-mercato/cezar/pull/454'],
        })}
        thread={reduceThread(EVENTS)}
      />,
      undefined,
      { repo: { root: '/repo', branch: 'main', remote: 'git@github.com:open-mercato/cezar.git' } },
    )
    await waitFor(() => {
      expect(document.querySelector('[data-slot="issue-link"]')).not.toBeNull()
    })
    const footer = document.querySelector('[data-slot="thread-footer"]')
    expect(footer?.querySelector('[data-slot="issue-link"]')?.getAttribute('href')).toBe(
      'https://github.com/open-mercato/cezar/issues/524',
    )
    expect(footer?.querySelector('[data-slot="issue-link"]')?.textContent).toContain('Issue')
    expect(footer?.querySelector('[data-slot="pr-link"]')).toBeNull()
  })

  /**
   * `/health` is workspace-level — the server builds it from the BOOT project's root whatever
   * the URL is scoped to. So a task belonging to another registered project must synthesize
   * nothing: a link built from the boot project's remote would name a completely different
   * repository, which is #526's defect wearing a different hat.
   */
  it('a task in a non-boot project synthesizes no issue link — health names the wrong repo (#526)', async () => {
    const issueRun = run('done', { markerRefs: { issue: 524 } })
    const health = {
      bootProject: 'cezar',
      repo: { root: '/repo', branch: 'main', remote: 'git@github.com:open-mercato/cezar.git' },
    }

    // Control — unscoped IS the boot project, so health's remote really is this task's repo.
    renderView(<ThreadView run={issueRun} thread={reduceThread(EVENTS)} />, undefined, health)
    await waitFor(() => {
      expect(document.querySelector('[data-slot="issue-link"]')?.getAttribute('href')).toBe(
        'https://github.com/open-mercato/cezar/issues/524',
      )
    })
    cleanup()

    // Scoped to a DIFFERENT registered project: same health, and the link must stay away.
    const { queryClient } = renderView(
      <ProjectScopeProvider projectId="other-project">
        <ThreadView run={issueRun} thread={reduceThread(EVENTS)} />
      </ProjectScopeProvider>,
      undefined,
      health,
    )
    // Health HAS arrived under this scope — the missing link is a refusal, not a slow render.
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.health)).toBeDefined())
    expect(document.querySelector('[data-slot="issue-link"]')).toBeNull()
  })

  it('a PR-subject closed run still gets its PR link and no invented issue link (#526)', () => {
    renderView(
      <ThreadView
        run={run('done', { pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/900' })}
        thread={reduceThread(EVENTS)}
      />,
      undefined,
      { repo: { root: '/repo', branch: 'main', remote: 'git@github.com:open-mercato/cezar.git' } },
    )
    const footer = document.querySelector('[data-slot="thread-footer"]')
    expect(footer?.querySelector('[data-slot="pr-link"]')?.getAttribute('href')).toBe(
      'https://github.com/open-mercato/cezar/pull/900',
    )
    expect(footer?.querySelector('[data-slot="issue-link"]')).toBeNull()
  })

  it('running → no footer (the stream itself is the status), and no invented empty state', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread(EVENTS)} />)
    expect(document.querySelector('[data-slot="thread-footer"]')).toBeNull()
    expect(document.querySelector('[data-slot="thread-empty"]')).toBeNull()
  })

  it('an eventless run says so instead of rendering blank space', () => {
    renderView(<ThreadView run={run('running')} thread={reduceThread([])} />)
    expect(document.querySelector('[data-slot="thread-empty"]')?.textContent).toBe('No session events yet.')
  })

  it('an eventless QUEUED run gets the queued placeholder, not the generic empty line (#351)', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread([])} />)
    const placeholder = document.querySelector('[data-slot="queued-state"]')
    expect(placeholder?.textContent).toContain('Waiting for a free agent slot')
    expect(placeholder?.textContent).toContain('quick-task · starts automatically')
    expect(document.querySelector('[data-slot="thread-empty"]')).toBeNull()
  })

  it('the first real event replaces the queued placeholder', () => {
    renderView(<ThreadView run={run('queued')} thread={reduceThread([line(1, 'lifecycle', { message: 'cezar restarted — task re-queued' })])} />)
    expect(document.querySelector('[data-slot="queued-state"]')).toBeNull()
    expect(document.querySelector('[data-slot="note-line"]')?.textContent).toContain('re-queued')
  })

  it('no plan → no dock, no header mirror; steps present → the rail renders in the header', () => {
    renderView(
      <ThreadView
        run={run('running', {
          steps: [
            { id: 'task', name: 'Do the task', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0 },
            { id: 'verify', name: 'Verify', kind: 'check', status: 'pending', iterations: 1, tokensUsed: 0 },
          ],
        })}
        thread={reduceThread(EVENTS)}
      />,
    )
    expect(document.querySelector('[data-slot="plan-dock"]')).toBeNull()
    expect(document.querySelector('[data-slot="plan-mirror"]')).toBeNull()
    // The header shows the compact one-line summary (collapsed by default): a dot per step and
    // the active step's name + position. The full rows only mount once it's expanded.
    const summary = document.querySelector('[data-slot="workflow-steps"]')
    expect(summary).not.toBeNull()
    expect(summary!.textContent).toContain('Do the task')
    expect(summary!.textContent).toContain('step 1 of 2')
    const dots = [...document.querySelectorAll('[data-slot="step-dot"]')]
    expect(dots.map((dot) => dot.getAttribute('data-visual'))).toEqual(['active', 'pending'])
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })

  it('a plan in the stream → the dock above the composer area + the compact header mirror', () => {
    const withPlan: RunEvent[] = [
      ...EVENTS,
      line(8, 'plan.updated', {
        entries: [
          { content: 'Read the docs', status: 'completed' },
          { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
          { content: 'Reply', status: 'pending' },
        ],
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(withPlan)} />)
    expect(document.querySelector('[data-slot="plan-dock"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="plan-count"]')?.textContent).toBe('· 1/3')
    expect(document.querySelector('[data-slot="plan-mirror"]')?.textContent).toBe('Plan 1/3')
    // No steps on this run — the rail knows to stay away.
    expect(document.querySelector('[data-slot="step-rail"]')).toBeNull()
  })

  it('plan-kind tool cards stay out of the thread — the dock is their surface (#382)', () => {
    const todoInput = {
      todos: [
        { content: 'Read the docs', status: 'completed', activeForm: 'Reading the docs' },
        { content: 'Summarize', status: 'in_progress', activeForm: 'Summarizing' },
      ],
    }
    const events: RunEvent[] = [
      line(1, 'turn.started', { turnId: 'turn_1' }),
      line(2, 'item.started', {
        item: { kind: 'tool', id: 'toolu_todo', name: 'TodoWrite', toolKind: 'plan', title: 'Update plan', status: 'running', input: todoInput },
      }),
      line(3, 'plan.updated', { entries: todoInput.todos }),
      line(4, 'item.completed', {
        item: { kind: 'tool', id: 'toolu_todo', name: 'TodoWrite', toolKind: 'plan', title: 'Update plan', status: 'completed', input: todoInput },
      }),
    ]
    renderView(<ThreadView run={run('running')} thread={reduceThread(events)} />)
    expect(document.querySelector('[data-slot="tool-card"]')).toBeNull()
    expect(document.querySelector('[data-slot="plan-dock"]')).not.toBeNull()
  })
})

/** The bounded-history routes the thread route hydrates from (progressive-history spec): the
 *  newest page and the compact current-state context. The route-level suites below are about the
 *  RECORD — the auto-resume hint, the read receipt — not the transcript, so they answer both with
 *  an honest empty session. A catch-all `{}` would not do: these are typed payloads the hook
 *  reads directly, so an unmodelled route makes the whole thread fail for a reason that has
 *  nothing to do with what the test is proving. */
const EMPTY_HISTORY_PAGE = {
  events: [],
  itemCount: 0,
  liveCursor: 'live-0',
  asOfSeq: 0,
  hasOlder: false,
}
const EMPTY_HISTORY_CONTEXT = { contextEvents: [], asOfSeq: 0 }

/** The history payload for `path`, or `undefined` when it is not a history route — so each fetch
 *  stub below keeps its own routing table and only defers the two shared shapes to here. */
function historyBodyFor(path: string, id: string): unknown {
  if (path === `/api/v1/runs/${id}/history`) return EMPTY_HISTORY_PAGE
  if (path === `/api/v1/runs/${id}/history-context`) return EMPTY_HISTORY_CONTEXT
  return undefined
}

/** Route-level: loading and 404 — driven through the real fetch boundary. jsdom has no
 *  EventSource, which `useRunEvents` treats as "no stream" — honest for these states. */
function renderRoute(id: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/tasks/${id}`]}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskThreadRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('TaskThreadRoute', () => {
  it('is honestly loading while /api/v1/runs/:id has not answered', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    renderRoute('r1')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Loading task…')
    expect(document.querySelector('[data-route="task-thread"]')).not.toBeNull()
  })

  it('renders the auto-resume hint from what GET /runs/:id actually answers', async () => {
    // The whole path, not just the component: the record shape is copied verbatim from a live
    // `GET /api/v1/runs/:id` after a `mock:limit` run, so a field that survives the server but
    // gets lost between fetch, cache and dock fails here (spec
    // 2026-08-03-auto-resume-after-usage-limit).
    const record = {
      id: 'r1',
      title: 'mock:limit ship it',
      workflow: 'quick-task',
      task: 'mock:limit ship it',
      status: 'failed',
      error: 'step "task" failed: Claude AI usage limit reached|1785785603',
      autoResumeAt: '2026-08-03T19:33:53.000Z',
      createdAt: '2026-08-03T19:23:00.000Z',
      finishedAt: '2026-08-03T19:23:13.000Z',
      tokensUsed: 0,
      archived: false,
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0, sessionId: 's1' }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const path = String(input)
        const history = historyBodyFor(path, 'r1')
        const body =
          history !== undefined ? history : path === '/api/v1/runs/r1' ? record : path === '/api/v1/health' ? {} : []
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }),
    )
    renderRoute('r1')
    const hint = await waitFor(() => {
      const found = document.querySelector('[data-slot="auto-resume-hint"]')
      expect(found).not.toBeNull()
      return found
    })
    expect(hint?.textContent).toContain('Usage limit reached — this task resumes automatically at')
  })

  it('unknown run id → the 404-style CenteredState with a way home', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })),
      ),
    )
    renderRoute('nope')
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Task not found')
    })
    expect(screen.getByRole('link', { name: 'Back to tasks' }).getAttribute('href')).toBe('/')
    expect(document.querySelector('[data-slot="centered-state"]')?.getAttribute('data-tone')).toBe('neutral')
  })
})

/**
 * Read receipts through the real route (#unread-done-items, #775). These drive the whole loop —
 * fetch → cache → the auto-mark-read effect → the header's Mark unread → fetch again — because
 * the interesting behavior only exists at that junction: the effect and the action pull the
 * receipt in opposite directions on the very same record.
 */
describe('TaskThreadRoute — read receipts', () => {
  const FINISHED_AT = '2026-07-14T13:00:00.000Z'
  const SEEN_AT = '2026-07-14T13:05:00.000Z'
  const RE_SEEN_AT = '2026-07-14T14:00:00.000Z'

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  /** A fetch stub that actually MODELS the receipt: `/read` stamps it, `/unread` clears it, and
   *  `GET /runs/:id` answers the current record. A stub that always replayed the initial record
   *  would hide the exact bug this suite exists for — the effect re-firing on a cleared receipt. */
  function stubReceiptServer(initial: ApiRun) {
    const sent: Array<{ path: string; method: string }> = []
    let current: ApiRun = { ...initial }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        sent.push({ path, method })
        if (method === 'POST' && path === `/api/v1/runs/${initial.id}/read`) {
          current = { ...current, seenAt: RE_SEEN_AT }
          return Promise.resolve(jsonResponse(current))
        }
        if (method === 'POST' && path === `/api/v1/runs/${initial.id}/unread`) {
          const { seenAt: _cleared, ...rest } = current
          current = rest as ApiRun
          return Promise.resolve(jsonResponse(current))
        }
        const history = historyBodyFor(path, initial.id)
        if (history !== undefined) return Promise.resolve(jsonResponse(history))
        if (path === `/api/v1/runs/${initial.id}`) return Promise.resolve(jsonResponse(current))
        if (path === '/api/v1/runs') return Promise.resolve(jsonResponse([]))
        if (path === '/api/v1/providers/status') {
          return Promise.resolve(
            jsonResponse({
              providers: [
                { provider: 'claude', status: 'connected', enabled: true },
                { provider: 'codex', status: 'not-installed', enabled: true },
                { provider: 'opencode', status: 'not-installed', enabled: true },
              ],
            }),
          )
        }
        return Promise.resolve(jsonResponse({}))
      }),
    )
    return { sent, currentRecord: () => current }
  }

  /** A fresh visit to `/tasks/:id` — a NEW route instance every time, which is what makes the
   *  suppression's per-visit reset observable. The query client is shared across visits on
   *  purpose: navigating away and back inside the cockpit does not empty the cache. */
  function visit(id: string, queryClient = createQueryClient()) {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/tasks/${id}`]}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskThreadRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return { ...view, queryClient }
  }

  const posted = (sent: Array<{ path: string; method: string }>, path: string) =>
    sent.filter((r) => r.method === 'POST' && r.path === path).length

  it('opening an unread finished task marks it read', async () => {
    const { sent } = stubReceiptServer(run('done', { finishedAt: FINISHED_AT }))
    visit('r1')
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/read')).toBe(1))
  })

  it('marking unread inside the open thread is NOT re-stamped by the auto-read effect', async () => {
    // The regression this feature lives or dies on: clearing the receipt makes `isUnread` true
    // again, and the auto-mark-read effect re-runs on exactly that change. Without the per-visit
    // suppression it would immediately POST /read and the action would look broken.
    const { sent, currentRecord } = stubReceiptServer(
      run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT }),
    )
    visit('r1')

    fireEvent.click(await screen.findByRole('button', { name: 'Mark unread' }))
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/unread')).toBe(1))

    // Let every settled mutation, cache write and re-render drain before judging.
    await waitFor(() => expect(currentRecord().seenAt).toBeUndefined())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(posted(sent, '/api/v1/runs/r1/read')).toBe(0)
    expect(currentRecord().seenAt).toBeUndefined()
  })

  it('a later fresh visit marks it read again — reopening the mail still counts', async () => {
    // The suppression is per-visit, not sticky: the email grammar this is modelled on says a
    // task you deliberately put back to unread goes read again the next time you open it.
    const { sent, currentRecord } = stubReceiptServer(
      run('done', { finishedAt: FINISHED_AT, seenAt: SEEN_AT }),
    )
    const first = visit('r1')

    fireEvent.click(await screen.findByRole('button', { name: 'Mark unread' }))
    await waitFor(() => expect(currentRecord().seenAt).toBeUndefined())
    expect(posted(sent, '/api/v1/runs/r1/read')).toBe(0)
    first.unmount()

    visit('r1', first.queryClient)
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/read')).toBe(1))
    expect(currentRecord().seenAt).toBe(RE_SEEN_AT)
  })

  it('the control appears as soon as opening the task has marked it read', async () => {
    // Opening an unread task is what makes the action meaningful in the first place: the auto-read
    // effect stamps the receipt, and the header immediately offers the way back. (The
    // still-unread case cannot be reached from this route — it is covered where the header's flag
    // is driven directly, in run-header.test.tsx.)
    const { sent } = stubReceiptServer(run('done', { finishedAt: FINISHED_AT }))
    visit('r1')
    await waitFor(() => expect(posted(sent, '/api/v1/runs/r1/read')).toBe(1))
    expect(await screen.findByRole('button', { name: 'Mark unread' })).not.toBeNull()
  })
})
