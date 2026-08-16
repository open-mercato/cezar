import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  archiveFinished,
  archiveRun,
  cancelRun,
  connectProvider,
  continueRun,
  createRun,
  deleteRun,
  finishRun,
  getGithub,
  getGithubChecks,
  getGithubRefStatus,
  getGroup,
  getHealth,
  getProviderStatus,
  getRepo,
  getRunnerModels,
  getRun,
  getRunDiff,
  getRunHandoff,
  getRunHistory,
  getRunHistoryContext,
  getRuns,
  getSkills,
  getSkillsWhenReady,
  getTodos,
  getUiState,
  getWorkflows,
  openRunInCli,
  patchRun,
  pickVariant,
  putUiState,
  refreshSkills,
  removeTodo,
  runFileRawUrl,
  sendMessage,
  setProviderEnabled,
  startTodo,
  retryProviderAuth,
} from './client'
import { setApiScope } from '@open-mercato/cezar-api-client'

/** The one seam under test: every call must go through `fetch` and nothing else. */
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function reply(body: unknown, init: ResponseInit = {}): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    }),
  )
}

const VALID_PROVIDER_STATUS = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

/** The (path, init) the client actually asked for. */
function lastCall(): { path: string; method: string; body: unknown; headers: Headers; credentials: RequestCredentials | undefined } {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) throw new Error('fetch was never called')
  const [path, init = {}] = call as [string, RequestInit]
  return {
    path,
    method: String(init.method),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    headers: new Headers(init.headers),
    credentials: init.credentials,
  }
}

describe('request shapes', () => {
  const cases: Array<{
    name: string
    call: () => Promise<unknown>
    path: string
    method: string
    body?: unknown
  }> = [
    { name: 'getHealth', call: () => getHealth(), path: '/api/v1/health', method: 'GET' },
    {
      name: 'getProviderStatus',
      call: () => getProviderStatus(),
      path: '/api/v1/providers/status',
      method: 'GET',
    },
    {
      name: 'getProviderStatus (refresh)',
      call: () => getProviderStatus(true),
      path: '/api/v1/providers/status?refresh=1',
      method: 'GET',
    },
    {
      name: 'connectProvider',
      call: () => connectProvider('codex'),
      path: '/api/v1/providers/connect',
      method: 'POST',
      body: { provider: 'codex' },
    },
    {
      name: 'setProviderEnabled',
      call: () => setProviderEnabled('codex', false),
      path: '/api/v1/providers/codex/enabled',
      method: 'PUT',
      body: { enabled: false },
    },
    {
      name: 'retryProviderAuth',
      call: () => retryProviderAuth('claude', 'incident-1'),
      path: '/api/v1/providers/claude/retry',
      method: 'POST',
      body: { authFailureId: 'incident-1' },
    },
    { name: 'getRunnerModels', call: () => getRunnerModels('codex'), path: '/api/v1/models?runner=codex', method: 'GET' },
    { name: 'getRunnerModels(opencode)', call: () => getRunnerModels('opencode'), path: '/api/v1/models?runner=opencode', method: 'GET' },
    { name: 'getRuns', call: () => getRuns(), path: '/api/v1/runs', method: 'GET' },
    { name: 'getRun', call: () => getRun('run-1'), path: '/api/v1/runs/run-1', method: 'GET' },
    { name: 'getRunDiff', call: () => getRunDiff('run-1'), path: '/api/v1/runs/run-1/diff', method: 'GET' },
    { name: 'getRunHandoff', call: () => getRunHandoff('run-1'), path: '/api/v1/runs/run-1/handoff', method: 'GET' },
    { name: 'getUiState', call: () => getUiState(), path: '/api/v1/ui-state', method: 'GET' },
    { name: 'getWorkflows', call: () => getWorkflows(), path: '/api/v1/workflows', method: 'GET' },
    { name: 'getSkills', call: () => getSkills(), path: '/api/v1/skills', method: 'GET' },
    {
      name: 'getSkillsWhenReady',
      call: () => getSkillsWhenReady(),
      path: '/api/v1/skills?wait=1',
      method: 'GET',
    },
    { name: 'refreshSkills', call: () => refreshSkills(), path: '/api/v1/skills/refresh', method: 'POST' },
    { name: 'getTodos', call: () => getTodos(), path: '/api/v1/todos', method: 'GET' },
    { name: 'getRepo', call: () => getRepo(), path: '/api/v1/repo', method: 'GET' },
    { name: 'getGroup', call: () => getGroup('grp-1'), path: '/api/v1/groups/grp-1', method: 'GET' },
    {
      name: 'pickVariant',
      call: () => pickVariant('grp-1', 'run-a'),
      path: '/api/v1/groups/grp-1/pick',
      method: 'POST',
      body: { runId: 'run-a' },
    },
    { name: 'getGithub (no params)', call: () => getGithub(), path: '/api/v1/github', method: 'GET' },
    {
      name: 'getGithub (limit + refresh)',
      call: () => getGithub({ limit: 5, refresh: true }),
      path: '/api/v1/github?limit=5&refresh=1',
      method: 'GET',
    },
    // `refresh: false` must not become `refresh=0` — the server tests `=== '1'`, but sending a
    // parameter we do not mean is how a "false" ends up read as truthy somewhere downstream.
    { name: 'getGithub (refresh false)', call: () => getGithub({ refresh: false }), path: '/api/v1/github', method: 'GET' },
    {
      name: 'getGithubChecks (#664)',
      call: () => getGithubChecks([7, 12]),
      path: '/api/v1/github/checks?prs=7%2C12',
      method: 'GET',
    },
    {
      name: 'getGithubRefStatus (both kinds)',
      call: () => getGithubRefStatus('api', { prs: [7, 12], issues: [3] }),
      // The project is EXPLICIT, not the active scope: the global Tasks page asks about rows
      // belonging to projects it is not standing in.
      path: '/api/v1/p/api/github/ref-status?prs=7%2C12&issues=3',
      method: 'GET',
    },
    {
      name: 'getGithubRefStatus (one kind — the empty list is not sent)',
      // An empty `prs=` is a malformed list to the route (a 400), where an ABSENT key means
      // "not asked for". The difference has to survive the client.
      call: () => getGithubRefStatus('api', { issues: [3] }),
      path: '/api/v1/p/api/github/ref-status?issues=3',
      method: 'GET',
    },
    {
      name: 'putUiState',
      call: () => putUiState({ runsView: 'table' }),
      path: '/api/v1/ui-state',
      method: 'PUT',
      body: { runsView: 'table' },
    },
    {
      name: 'createRun',
      call: () => createRun({ task: 'do it', workflow: 'quick-task', variants: 2 }),
      path: '/api/v1/runs',
      method: 'POST',
      body: { task: 'do it', workflow: 'quick-task', variants: 2 },
    },
    { name: 'cancelRun', call: () => cancelRun('run-1'), path: '/api/v1/runs/run-1/cancel', method: 'POST' },
    {
      name: 'archiveRun (default)',
      call: () => archiveRun('run-1'),
      path: '/api/v1/runs/run-1/archive',
      method: 'POST',
      body: { archived: true },
    },
    {
      name: 'archiveRun (unarchive)',
      call: () => archiveRun('run-1', false),
      path: '/api/v1/runs/run-1/archive',
      method: 'POST',
      body: { archived: false },
    },
    {
      name: 'archiveFinished',
      call: () => archiveFinished(),
      path: '/api/v1/runs/archive-finished',
      method: 'POST',
    },
    { name: 'finishRun', call: () => finishRun('run-1'), path: '/api/v1/runs/run-1/finish', method: 'POST' },
    {
      name: 'continueRun (no text)',
      call: () => continueRun('run-1'),
      path: '/api/v1/runs/run-1/continue',
      method: 'POST',
      body: {},
    },
    {
      name: 'continueRun (with text)',
      call: () => continueRun('run-1', { text: 'keep going' }),
      path: '/api/v1/runs/run-1/continue',
      method: 'POST',
      body: { text: 'keep going' },
    },
    {
      name: 'continueRun (runner + model override, #401)',
      call: () => continueRun('run-1', { runner: 'codex', model: 'gpt-5.1-codex' }),
      path: '/api/v1/runs/run-1/continue',
      method: 'POST',
      body: { runner: 'codex', model: 'gpt-5.1-codex' },
    },
    { name: 'deleteRun', call: () => deleteRun('run-1'), path: '/api/v1/runs/run-1', method: 'DELETE' },
    // Inbox actions (R6 1.2): the exact legacy endpoints, ids URL-encoded like every other path.
    { name: 'removeTodo', call: () => removeTodo('todo/1'), path: '/api/v1/todos/todo%2F1', method: 'DELETE' },
    { name: 'startTodo', call: () => startTodo('todo/1'), path: '/api/v1/todos/todo%2F1/start', method: 'POST' },
    // #413: extra instructions (e.g. an inserted prompt template) ride an optional body;
    // omitted (the case above) sends none at all — the pre-#413 call shape.
    {
      name: 'startTodo (with prompt)',
      call: () => startTodo('todo/1', { prompt: 'Also add tests.' }),
      path: '/api/v1/todos/todo%2F1/start',
      method: 'POST',
      body: { prompt: 'Also add tests.' },
    },
    {
      // #401: an Inbox card that picked a backend. No pick → the bodyless POST above, unchanged.
      name: 'startTodo (runner + model override, #401)',
      call: () => startTodo('todo/1', { runner: 'codex', model: 'gpt-5.1-codex' }),
      path: '/api/v1/todos/todo%2F1/start',
      method: 'POST',
      body: { runner: 'codex', model: 'gpt-5.1-codex' },
    },
    {
      // Auto ('') and a single-backend host are filtered out by the caller, so a body that
      // reaches the wire never carries an empty model or a redundant runner.
      name: 'startTodo (model only, #401)',
      call: () => startTodo('todo/1', { model: 'opus' }),
      path: '/api/v1/todos/todo%2F1/start',
      method: 'POST',
      body: { model: 'opus' },
    },
    {
      name: 'openRunInCli',
      call: () => openRunInCli('run-1'),
      path: '/api/v1/runs/run-1/open-in-cli',
      method: 'POST',
    },
    {
      name: 'patchRun',
      call: () => patchRun('run-1', { title: 'New name' }),
      path: '/api/v1/runs/run-1',
      method: 'PATCH',
      body: { title: 'New name' },
    },
    {
      name: 'sendMessage',
      call: () => sendMessage('run-1', { text: 'hi' }),
      path: '/api/v1/runs/run-1/messages',
      method: 'POST',
      // The server's schema defaults both, but an absent `images` and `[]` are the same
      // request — send the shape the endpoint documents rather than half of it.
      body: { text: 'hi', images: [] },
    },
    {
      name: 'sendMessage (images only)',
      call: () => sendMessage('run-1', { images: [{ mediaType: 'image/png', data: 'AAA' }] }),
      path: '/api/v1/runs/run-1/messages',
      method: 'POST',
      body: { text: '', images: [{ mediaType: 'image/png', data: 'AAA' }] },
    },
  ]

  it.each(cases)('$name hits $method $path', async ({ call, path, method, body }) => {
    reply(path.startsWith('/api/v1/providers/') ? VALID_PROVIDER_STATUS : { ok: true })
    await call()

    const sent = lastCall()
    expect(sent.path).toBe(path)
    expect(sent.method).toBe(method)
    expect(sent.body).toEqual(body)
    expect(sent.credentials).toBe('include')
    if (body !== undefined) expect(sent.headers.get('content-type')).toBe('application/json')
  })

  it('escapes run ids into the path', async () => {
    reply({ cancelled: true })
    await cancelRun('a b/../c')
    expect(lastCall().path).toBe('/api/v1/runs/a%20b%2F..%2Fc/cancel')
  })

  it('hands out the byte-identical legacy raw-image URL when unscoped', () => {
    // The one URL this module builds without fetching it (an <img> loads it) — same invariant
    // as every case above: unscoped means exactly the pre-multi-project path.
    expect(runFileRawUrl('run-1', 'shots/final.png')).toBe('/api/v1/runs/run-1/files?path=shots%2Ffinal.png&raw=1')
  })

  it('forwards an abort signal to fetch', async () => {
    reply([])
    const controller = new AbortController()
    await getRuns({ signal: controller.signal })
    expect((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).signal).toBe(controller.signal)
  })
})

describe('project scope (multi-project spec, step 3.1)', () => {
  // NB the WHOLE unscoped table above is this feature's other half: the critical assertion is
  // that with no scope set, every path stays byte-identical — those cases prove it by never
  // touching the scope at all.
  afterEach(() => {
    setApiScope(null)
  })

  it('prefixes every request path with /api/v1/p/<id> once a scope is active', async () => {
    setApiScope('proj-a')

    reply({ ok: true })
    await getRuns()
    expect(lastCall().path).toBe('/api/v1/p/proj-a/runs')

    reply({ ok: true })
    await cancelRun('run-1')
    expect(lastCall().path).toBe('/api/v1/p/proj-a/runs/run-1/cancel')

    reply({ ok: true })
    await getGithub({ limit: 5 })
    expect(lastCall().path).toBe('/api/v1/p/proj-a/github?limit=5')

    // The non-send() site scopes the same way — the <img> URL it hands out must hit the
    // scoped route or another project's cockpit would render this project's bytes as a 404.
    expect(runFileRawUrl('run-1', 'x.png')).toBe('/api/v1/p/proj-a/runs/run-1/files?path=x.png&raw=1')
  })

  it('keeps workspace-level routes unprefixed under a scope — health is single-mount', async () => {
    setApiScope('proj-a')
    reply({ version: '0.0.0' })
    await getHealth()
    expect(lastCall().path).toBe('/api/v1/health')
  })
})

describe('response parsing', () => {
  it('normalizes provider status into canonical order without unexpected fields', async () => {
    reply({
      ignored: 'top-level raw value',
      providers: [
        { provider: 'opencode', status: 'unknown', hint: 'Try again.', enabled: true, raw: 'private' },
        { provider: 'claude', status: 'connected', enabled: false, account: 'private@example.test' },
        { provider: 'codex', status: 'disconnected', enabled: true, authFailureId: 'incident-1', raw: 'private' },
      ],
    })

    await expect(getProviderStatus()).resolves.toEqual({
      providers: [
        { provider: 'claude', status: 'connected', enabled: false },
        { provider: 'codex', status: 'disconnected', enabled: true, authFailureId: 'incident-1' },
        { provider: 'opencode', status: 'unknown', hint: 'Try again.', enabled: true },
      ],
    })
  })

  it.each([
    ['an empty object', {}],
    ['null providers', { providers: null }],
    ['a null row', { providers: [null] }],
    [
      'an unknown state',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'future-state' },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
    [
      'a duplicate provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'claude', status: 'disconnected' },
          { provider: 'opencode', status: 'connected' },
        ],
      },
    ],
    [
      'a missing provider',
      {
        providers: [
          { provider: 'claude', status: 'connected' },
          { provider: 'codex', status: 'connected' },
        ],
      },
    ],
  ])('rejects a successful provider response containing %s', async (_case, body) => {
    reply(body)

    await expect(getProviderStatus()).rejects.toThrow('Invalid provider status response')
  })

  it('returns the health payload as-is', async () => {
    const health = {
      version: '0.1.3',
      latestVersion: '0.2.0',
      repoRoot: '/home/me/cezar',
      repo: { root: '/home/me/cezar', branch: 'main', remote: 'origin' },
      checks: [{ name: 'claude', available: true, version: '2.0.1' }],
      defaultRunner: 'claude',
    }
    reply(health)
    await expect(getHealth()).resolves.toEqual(health)
  })

  it('returns the run list', async () => {
    reply([{ id: 'run-1', title: 'Fix it', status: 'running' }])
    const runs = await getRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.id).toBe('run-1')
  })

  it('reads a diff as text, not JSON', async () => {
    const diff = 'diff --git a/x b/x\n+added\n'
    fetchMock.mockResolvedValue(
      new Response(diff, { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    await expect(getRunDiff('run-1')).resolves.toBe(diff)
  })

  it('reads the handoff journal as markdown text — an empty file is an empty string, not an error', async () => {
    fetchMock.mockResolvedValue(
      new Response('', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } }),
    )
    await expect(getRunHandoff('run-1')).resolves.toBe('')
  })

  it('passes an unavailable GitHub through as data — it is a hint, not a failure', async () => {
    reply({ available: false, reason: 'gh is not installed', issues: [], prs: [] })
    const data = await getGithub()
    expect(data.available).toBe(false)
    expect(data.reason).toBe('gh is not installed')
  })
})

describe('errors', () => {
  function fail(status: number, body: string, contentType = 'application/json'): void {
    fetchMock.mockResolvedValue(
      new Response(body, { status, statusText: statusTextFor(status), headers: { 'content-type': contentType } }),
    )
  }

  function statusTextFor(status: number): string {
    return { 404: 'Not Found', 409: 'Conflict', 500: 'Internal Server Error' }[status] ?? ''
  }

  it('surfaces the server error message verbatim', async () => {
    fail(409, JSON.stringify({ error: 'run is active — cancel it first' }))
    const error = await deleteRun('run-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).message).toBe('run is active — cancel it first')
  })

  it('carries the 409 extras the server pairs with the reason', async () => {
    fail(409, JSON.stringify({ error: 'push failed: no upstream', manual: 'git merge cez/abc' }))
    const error = (await createRun({ task: 't', workflow: 'quick-task' }).catch((e: unknown) => e)) as ApiError
    expect(error.status).toBe(409)
    expect(error.message).toBe('push failed: no upstream')
    // The manual way out has to reach the UI — a 409 the user cannot act on is a dead end.
    expect(error.manual).toBe('git merge cez/abc')
    expect(error.command).toBeUndefined()
    expect(error.exists).toBeUndefined()
  })

  it.each([
    { name: 'command (open-in-cli)', body: { error: 'no terminal emulator found', command: "cd '/r' && claude --resume x" } },
    { name: 'exists (save workflow)', body: { error: 'workflow file already exists: /r/x.yaml', exists: true } },
  ])('carries $name', async ({ body }) => {
    fail(409, JSON.stringify(body))
    const error = (await cancelRun('run-1').catch((e: unknown) => e)) as ApiError
    expect(error.message).toBe(body.error)
    if ('command' in body) expect(error.command).toBe(body.command)
    if ('exists' in body) expect(error.exists).toBe(true)
  })

  it('turns a non-JSON 500 into a sane ApiError rather than a parse error', async () => {
    fail(500, '<html><body>502 Bad Gateway</body></html>', 'text/html')
    const error = await getRuns().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(500)
    // Says what we know; does not paste a page of HTML into a toast.
    expect((error as ApiError).message).toBe('500 Internal Server Error')
    expect((error as Error).name).toBe('ApiError')
  })

  it('survives an empty error body', async () => {
    fail(404, '')
    const error = (await getRun('nope').catch((e: unknown) => e)) as ApiError
    expect(error.status).toBe(404)
    expect(error.message).toBe('404 Not Found')
  })

  it('ignores a non-string error field instead of stringifying junk', async () => {
    fail(400, JSON.stringify({ error: { issues: ['bad'] } }))
    const error = (await getRuns().catch((e: unknown) => e)) as ApiError
    // No statusText either — the fallback still has to read as a sentence.
    expect(error.message).toBe('400 request failed')
  })

  it('reports an unreachable server as status 0, keeping the cause', async () => {
    const cause = new TypeError('Failed to fetch')
    fetchMock.mockRejectedValue(cause)
    const error = (await getHealth().catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(0)
    expect(error.message).toContain('/api/v1/health')
    expect(error.cause).toBe(cause)
  })

  it('lets an abort through as an AbortError, not an ApiError', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))
    const error = await getRuns().catch((e: unknown) => e)
    // Query cancellation is not a server failure and must not be reported as one.
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as DOMException).name).toBe('AbortError')
  })

  it('rejects a 200 that is not JSON on a JSON endpoint', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }))
    const error = (await getRuns().catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toContain('non-JSON')
  })

  it('reports a diff endpoint failure too', async () => {
    fail(404, JSON.stringify({ error: 'not found' }))
    const error = (await getRunDiff('nope').catch((e: unknown) => e)) as ApiError
    expect(error.status).toBe(404)
    expect(error.message).toBe('not found')
  })
})

/**
 * The history routes are the two whose 200 is VALIDATED, not merely cast (#827).
 *
 * `useRunHistory` iterates `page.events`, so a body that is not a page would throw a `TypeError`
 * mid-render instead of rejecting the query — and the hook's full-replay fallback only triggers
 * on a rejection. These pin that a malformed 200 becomes an `ApiError`, which is what routes it
 * into that fallback.
 */
describe('history responses are validated at the boundary (#827)', () => {
  const PAGE = {
    events: [{ seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'assistant', text: 'hi' }],
    itemCount: 1,
    liveCursor: 'cursor-live',
    asOfSeq: 1,
    hasOlder: false,
  }
  const CONTEXT = {
    contextEvents: [{ seq: 1, ts: '2026-01-01T00:00:00.000Z', type: 'assistant' }],
    asOfSeq: 1,
  }

  it('passes a well-formed page through unchanged, additive event keys included', async () => {
    reply({ ...PAGE, olderCursor: 'cursor-older' })
    const page = await getRunHistory('run-1')
    expect(page.itemCount).toBe(1)
    expect(page.olderCursor).toBe('cursor-older')
    expect(page.newerCursor).toBeUndefined()
    // The event schema is open (append-only vocabulary) — payload keys must survive validation.
    expect(page.events[0]).toMatchObject({ seq: 1, type: 'assistant', text: 'hi' })
  })

  it('passes a well-formed context through unchanged', async () => {
    reply(CONTEXT)
    const context = await getRunHistoryContext('run-1')
    expect(context.asOfSeq).toBe(1)
    expect(context.contextEvents).toHaveLength(1)
  })

  it('rejects a 200 whose page body is the catch-all empty object', async () => {
    reply({})
    const error = (await getRunHistory('run-1').catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(200)
    expect(error.message).toBe('the cezar server answered /runs/run-1/history with an unexpected body')
  })

  it('rejects a 200 whose page carries a non-array `events`', async () => {
    reply({ ...PAGE, events: 'nope' })
    const error = (await getRunHistory('run-1').catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.message).toContain('unexpected body')
  })

  it('rejects a 200 whose context body is the catch-all empty object', async () => {
    reply({})
    const error = (await getRunHistoryContext('run-1').catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(200)
    expect(error.message).toBe(
      'the cezar server answered /runs/run-1/history-context with an unexpected body',
    )
  })

  it('still reports a real HTTP failure with the server\'s own words', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'run not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const error = (await getRunHistory('nope').catch((e: unknown) => e)) as ApiError
    expect(error.status).toBe(404)
    expect(error.message).toBe('run not found')
  })
})
