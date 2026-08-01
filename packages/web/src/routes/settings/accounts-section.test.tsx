import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { AgentProfile, AgentProfilesResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Agent accounts (spec `.ai/specs/2026-07-29-agent-profiles.md`).
 *
 * What this pins, in order of how easy each is to break:
 *
 * - the DISCOVERED account carries no Rename/Remove — it is a fact, not a setting;
 * - a folder the CLI has not created yet is listed honestly, not refused;
 * - Remove says out loud that nothing on disk is deleted, because "Remove" next to a path reads
 *   as "delete my folder";
 * - hosted mode shows no paths at all.
 */

const profile = (over: Partial<AgentProfile> & Pick<AgentProfile, 'id'>): AgentProfile => ({
  provider: 'claude',
  label: over.id,
  configDir: `~/.claude-${over.id}`,
  path: `/home/u/.claude-${over.id}`,
  exists: true,
  looksValid: true,
  isDefault: false,
  status: { provider: 'claude', status: 'connected' },
  files: [],
  ...over,
})

const DEFAULTS: AgentProfile[] = [
  profile({ id: 'default', label: 'Default', configDir: '/home/u/.claude', path: '/home/u/.claude', isDefault: true }),
  profile({
    id: 'default',
    provider: 'codex',
    label: 'Default',
    configDir: '/home/u/.codex',
    path: '/home/u/.codex',
    isDefault: true,
    status: { provider: 'codex', status: 'disconnected' },
    files: [],
  }),
]

let requests: Array<{ method: string; url: string; body?: unknown }> = []
/** Every `…/details` GET — used to prove none happens until the row is expanded. */
let detailReads: string[] = []
/** Every `…/status` GET — the listing must never carry auth, so each row asks for its own. */
let statusReads: string[] = []

function serve(
  response: AgentProfilesResponse,
  options: {
    deleteStatus?: number
    deleteError?: string
    createStatus?: number
    createError?: string
    details?: unknown
    openStatus?: number
    openError?: string
    targets?: unknown
    status?: unknown
  } = {},
) {
  requests = []
  detailReads = []
  statusReads = []
  let state = response
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/agent-profiles' && method === 'GET') return json(state)
      if (url.startsWith('/api/v1/workspace/agent-profiles/') && method === 'DELETE') {
        if (options.deleteStatus) return json({ error: options.deleteError }, options.deleteStatus)
        const id = url.split('/').pop()!
        state = { ...state, profiles: state.profiles.filter((p) => p.isDefault || p.id !== id) }
        return json({ removed: true, id })
      }
      if (url.startsWith('/api/v1/workspace/agent-profiles/') && method === 'PATCH') {
        const id = url.split('/').pop()!
        state = {
          ...state,
          profiles: state.profiles.map((p) =>
            !p.isDefault && p.id === id ? { ...p, label: String(body?.label ?? p.label) } : p,
          ),
        }
        return json({ profile: state.profiles.find((p) => !p.isDefault && p.id === id) })
      }
      if (url === '/api/v1/workspace/agent-profiles' && method === 'POST') {
        if (options.createStatus) return json({ error: options.createError }, options.createStatus)
        const created = profile({
          id: 'added',
          label: String(body?.label ?? 'added'),
          configDir: String(body?.configDir),
          path: String(body?.configDir).replace('~', '/home/u'),
          provider: body?.provider as AgentProfile['provider'],
        })
        state = { ...state, profiles: [...state.profiles, created] }
        return json({ profile: created }, 201)
      }
      if (url.includes('/agent-profiles/') && url.endsWith('/details') && method === 'GET') {
        detailReads.push(url)
        return json(options.details ?? { available: true, fields: [
          { label: 'Email', value: 'me@example.com' },
          { label: 'Organization', value: "me@example.com's Organization" },
        ] })
      }
      if (url.includes('/agent-profiles/') && url.endsWith('/open') && method === 'POST') {
        if (options.openStatus) return json({ error: options.openError }, options.openStatus)
        return json({ opened: true, path: '/home/u/.claude/settings.json' })
      }
      if (url.includes('/agent-profiles/') && url.includes('/status') && method === 'GET') {
        statusReads.push(url)
        return json({ status: options.status ?? { provider: 'claude', status: 'connected' } })
      }
      if (url.endsWith('/open-targets') && method === 'GET') {
        return json({ targets: options.targets ?? [
          { id: 'finder', label: 'Finder', icon: 'folder' },
          { id: 'terminal', label: 'Terminal', icon: 'terminal' },
          { id: 'vscode', label: 'VS Code', icon: 'vscode' },
          { id: 'cli:claude', label: 'Claude CLI', icon: 'claude' },
        ] })
      }
      if (url.startsWith('/api/v1/fs/browse') && method === 'GET') {
        return json({
          path: '/home/u',
          parent: null,
          dirs: [{ name: '.claude-second', path: '/home/u/.claude-second', isRepo: false }],
          truncated: false,
        })
      }
      if (url === '/api/v1/projects' && method === 'GET') {
        return json({ projects: [], bootProject: 'boot', projectsDir: '~/cezar/projects' })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderAccounts() {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    // The install/version rows come from the health probe — the one place a version can honestly
    // come from. Codex is present but UNAVAILABLE, which is "not installed"; an agent missing
    // from `checks` entirely is a different state ("Checking…") and must not be conflated.
    checks: [
      { name: 'claude', available: true, version: '2.1.220' },
      { name: 'codex', available: false, hint: 'optional: install the Codex CLI' },
    ],
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/accounts']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const rows = () => [...document.querySelectorAll('[data-slot="account-row"]')]
/** Switch to an agent's tab and wait for its panel to mount. */
const openTab = async (provider: string) => {
  await waitFor(() =>
    expect(document.querySelector(`[data-slot="accounts-tabs"] [data-provider="${provider}"]`)).not.toBeNull(),
  )
  // Radix activates a tab on mousedown, not click — a `click` alone leaves the panel unmounted.
  fireEvent.mouseDown(document.querySelector(`[data-slot="accounts-tabs"] [data-provider="${provider}"]`)!)
  await waitFor(() =>
    expect(document.querySelector(`[data-slot="accounts-provider"][data-provider="${provider}"]`)).not.toBeNull(),
  )
}
const rowFor = (id: string) => document.querySelector(`[data-slot="account-row"][data-account="${id}"]`)

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * Rename and Remove live inside "Show details", not on the collapsed row: a row is a reading
 * surface, and a destructive action on it sits one stray click away from a list you scan. So every
 * management assertion below opens the panel first — and the guards that those controls are ABSENT
 * check them with the panel open, or they would pass for the wrong reason.
 */
const openDetails = async (id: string) => {
  const row = await waitFor(() => {
    expect(rowFor(id)).not.toBeNull()
    return rowFor(id)!
  })
  fireEvent.click(row.querySelector('[data-action="account-details-toggle"]')!)
  await waitFor(() => expect(row.querySelector('[data-slot="account-details"]')).not.toBeNull())
  return row
}

describe('the agent accounts section', () => {
  it('lists the discovered account with no edit controls at all', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    // One tab at a time, so only the ACTIVE agent's rows are in the DOM.
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(document.body.textContent).toContain('discovered')
    // The discovered profile is what cezar found — a Rename or Remove would imply a setting. Checked
    // with the panel OPEN, since that is now the only place either could appear.
    await openDetails('default')
    expect(document.querySelector('[data-slot="account-manage"]')).toBeNull()
    expect(document.querySelector('[data-action="account-rename"]')).toBeNull()
    expect(document.querySelector('[data-action="account-remove"]')).toBeNull()
  })

  it('shows an extra account with its folder as the user wrote it', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    await waitFor(() => expect(rowFor('klaudiusz')).not.toBeNull())
    const row = rowFor('klaudiusz')!
    // Stored spelling in the text, the expanded absolute path only in the tooltip.
    expect(row.querySelector('[data-slot="account-path"]')?.textContent).toBe('~/.claude-klaudiusz')
    expect(row.querySelector('[data-slot="account-path"]')?.getAttribute('title')).toBe(
      '/home/u/.claude-klaudiusz',
    )
  })

  it('says a not-yet-created folder is fine, rather than showing it as broken', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'later', exists: false, looksValid: false })],
    })
    renderAccounts()

    await waitFor(() => expect(rowFor('later')).not.toBeNull())
    const row = rowFor('later')!
    expect(row.querySelector('[data-slot="account-missing"]')?.textContent).toContain(
      'Connect will make it',
    )
  })

  it('flags an unrecognised folder without refusing it', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'odd', exists: true, looksValid: false })],
    })
    renderAccounts()

    await waitFor(() => expect(rowFor('odd')).not.toBeNull())
    expect(rowFor('odd')!.querySelector('[data-slot="account-unrecognised"]')).not.toBeNull()
    // Still fully usable — the flow is add → Connect → the CLI writes the folder.
    const row = await openDetails('odd')
    expect(row.querySelector('[data-action="account-remove"]')).not.toBeNull()
  })

  /**
   * How a user actually signs a second account in. This is the gap that let the whole affordance
   * ship missing: the pane was thoroughly tested for rename, remove, details, open and selection,
   * and never asked how anyone logs in — while three separate strings told them to press Connect.
   */
  describe('signing an account in', () => {
    it('offers Connect on an account that is not signed in, aimed at THAT account', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [...DEFAULTS, profile({
          id: 'klaudiusz',
          label: 'Klaudiusz',
          status: { provider: 'claude', status: 'disconnected' },
        })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('klaudiusz')).not.toBeNull()
        return rowFor('klaudiusz')!
      })
      fireEvent.click(row.querySelector('[data-action="account-connect"]')!)

      await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/providers/connect')).toBe(true))
      // `profileId` is the whole point: without it the server signs the user into the DISCOVERED
      // account and reports success, which is the failure that made this a merge blocker.
      expect(requests.find((r) => r.url === '/api/v1/providers/connect')?.body).toEqual({
        provider: 'claude',
        profileId: 'klaudiusz',
      })
    })

    it('sends no profileId for the discovered account — it has no stored id', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [profile({
          id: 'default',
          label: 'Default',
          isDefault: true,
          status: { provider: 'claude', status: 'disconnected' },
        })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('default')).not.toBeNull()
        return rowFor('default')!
      })
      fireEvent.click(row.querySelector('[data-action="account-connect"]')!)

      await waitFor(() => expect(requests.some((r) => r.url === '/api/v1/providers/connect')).toBe(true))
      expect(requests.find((r) => r.url === '/api/v1/providers/connect')?.body).toEqual({
        provider: 'claude',
      })
    })

    it('hides Connect once the account IS signed in, but keeps Check again', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [...DEFAULTS, profile({
          id: 'klaudiusz',
          status: { provider: 'claude', status: 'connected' },
        })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('klaudiusz')).not.toBeNull()
        return rowFor('klaudiusz')!
      })
      await waitFor(() => expect(row.querySelector('[data-action="account-connect"]')).toBeNull())
      // A connected account can still have been logged out elsewhere, and the listing serves a
      // cached answer for minutes — so the re-check is what makes that recoverable.
      expect(row.querySelector('[data-action="account-recheck"]')).not.toBeNull()
    })

    it('re-checks ONE account for real, with refresh=1', async () => {
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        defaults: {},
        profiles: [...DEFAULTS, profile({ id: 'klaudiusz' })],
      })
      renderAccounts()

      const row = await waitFor(() => {
        expect(rowFor('klaudiusz')).not.toBeNull()
        return rowFor('klaudiusz')!
      })
      fireEvent.click(row.querySelector('[data-action="account-recheck"]')!)

      await waitFor(() =>
        expect(requests.some((r) => r.url.includes('/status?refresh=1'))).toBe(true))
    })
  })

  it('keeps Rename and Remove off the collapsed row, behind Show details', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    // Scanning the list must not put a destructive action under the cursor.
    const row = await waitFor(() => {
      expect(rowFor('klaudiusz')).not.toBeNull()
      return rowFor('klaudiusz')!
    })
    expect(row.querySelector('[data-action="account-remove"]')).toBeNull()
    expect(row.querySelector('[data-action="account-rename"]')).toBeNull()
    expect(row.querySelector('[data-slot="account-manage"]')).toBeNull()

    await openDetails('klaudiusz')
    expect(row.querySelector('[data-action="account-remove"]')).not.toBeNull()
    expect(row.querySelector('[data-action="account-rename"]')).not.toBeNull()

    // …and folding it away takes them with it.
    fireEvent.click(row.querySelector('[data-action="account-details-toggle"]')!)
    await waitFor(() => expect(row.querySelector('[data-slot="account-manage"]')).toBeNull())
  })

  it('renames without touching the folder', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    const row = await openDetails('klaudiusz')
    fireEvent.click(row.querySelector('[data-action="account-rename"]')!)
    fireEvent.change(screen.getByLabelText('Name for Klaudiusz'), { target: { value: 'Client A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(requests.some((r) => r.method === 'PATCH')).toBe(true))
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ label: 'Client A' })
  })

  it('confirms a removal by saying what is NOT deleted', async () => {
    serve({
      defaults: {},
      editable: true,
      profileCapableProviders: ['claude', 'codex'],
      selections: {},
      profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
    })
    renderAccounts()

    const row = await openDetails('klaudiusz')
    fireEvent.click(row.querySelector('[data-action="account-remove"]')!)

    const confirm = await waitFor(() => document.querySelector('[data-slot="accounts-remove-confirm"]')!)
    expect(confirm.textContent).toContain('~/.claude-klaudiusz')
    expect(confirm.textContent).toContain('is deleted')
    expect(confirm.textContent).toContain('fall back to the default account')

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'DELETE')).toBe(true))
    await waitFor(() => expect(rowFor('klaudiusz')).toBeNull())
  })

  it("surfaces a refused removal in the server's own words", async () => {
    serve(
      {
        defaults: {},
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
      selections: {},
        profiles: [...DEFAULTS, profile({ id: 'klaudiusz', label: 'Klaudiusz' })],
      },
      { deleteStatus: 409, deleteError: 'a task is still running on this account' },
    )
    renderAccounts()

    const row = await openDetails('klaudiusz')
    fireEvent.click(row.querySelector('[data-action="account-remove"]')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
        'a task is still running on this account',
      ),
    )
    // The row did not lie: it stayed, because the server refused.
    expect(rowFor('klaudiusz')).not.toBeNull()
  })

  describe('auth status arrives per row (perf split)', () => {
    it('renders immediately with Checking…, then fills each dot in', async () => {
      // The listing deliberately carries no `status`: probing it cost a CLI spawn per provider and
      // per account, ~2.5s on a real machine. The row says "Checking…" until its own answer lands,
      // which is a distinct state from any probe RESULT — `unknown` would claim a check that never ran.
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        profiles: [profile({ id: 'default', label: 'Default', isDefault: true, status: undefined })],
      } as never)
      renderAccounts()

      await waitFor(() => expect(rows()).toHaveLength(1))
      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-status"]')?.textContent).toBe('Connected'),
      )
      expect(statusReads).toHaveLength(1)
      expect(statusReads[0]).toContain('default%3Aclaude')
    })

    it('uses a status the listing DID carry, without asking again', async () => {
      // A server whose probe cache was already warm answers inline; re-asking would be a request
      // for something we already have.
      serve({
        editable: true,
        profileCapableProviders: ['claude', 'codex'],
        selections: {},
        profiles: [profile({
          id: 'default',
          label: 'Default',
          isDefault: true,
          status: { provider: 'claude', status: 'disconnected' },
        })],
      } as never)
      renderAccounts()

      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-status"]')?.textContent).toBe('Not connected'),
      )
    })
  })

  describe('Show details', () => {
    const CLAUDE_FILES = [
      { id: 'claude.user.settings', label: 'settings.json', path: '/home/u/.claude/settings.json', exists: true },
      { id: 'claude.user.memory', label: 'CLAUDE.md', path: '/home/u/.claude/CLAUDE.md', exists: false },
    ]
    const withFiles = () => ({
      editable: true as const,
      profileCapableProviders: ['claude', 'codex'] as const,
      selections: {},
      profiles: [profile({ id: 'default', label: 'Default', isDefault: true, files: CLAUDE_FILES })],
    })
    const toggle = () => document.querySelector<HTMLButtonElement>('[data-action="account-details-toggle"]')!

    it('fetches NOTHING until asked — hidden means absent, not merely unrendered', async () => {
      serve(withFiles() as never)
      renderAccounts()

      await waitFor(() => expect(rows()).toHaveLength(1))
      expect(detailReads).toEqual([])
      expect(document.querySelector('[data-slot="account-details"]')).toBeNull()
      // …and the listing itself never carried an identity to leak.
      expect(JSON.stringify(withFiles())).not.toContain('@example.com')
    })

    it('reveals the identity on demand, and hides it again', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))

      fireEvent.click(toggle())
      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-identity"]')?.textContent).toContain(
          'me@example.com',
        ),
      )
      expect(detailReads).toHaveLength(1)
      // Addressed as `default:<provider>`, since every discovered account shares `id: "default"`.
      expect(detailReads[0]).toContain('default%3Aclaude')

      fireEvent.click(toggle())
      await waitFor(() => expect(document.querySelector('[data-slot="account-details"]')).toBeNull())
    })

    it('says WHY there is nothing rather than showing an empty panel', async () => {
      serve(withFiles() as never, {
        details: { available: false, reason: 'Not signed in on this account yet — use Connect.', fields: [] },
      })
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))

      fireEvent.click(toggle())
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="account-identity-unavailable"]')?.textContent,
        ).toContain('Not signed in'),
      )
    })

    const fileMenus = () => [...document.querySelectorAll('[data-slot="account-open-file"]')]
    /** Radix opens on pointerdown; then pick an item by its target id. */
    const pickFrom = async (trigger: Element, target: string) => {
      fireEvent.pointerDown(trigger)
      await waitFor(() => expect(document.querySelector(`[data-target="${target}"]`)).not.toBeNull())
      fireEvent.click(document.querySelector(`[data-target="${target}"]`)!)
    }
    const openBody = () => requests.find((r) => r.url.endsWith('/open'))?.body

    it('offers each of the account\'s own config files, and its folder', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())

      await waitFor(() => expect(fileMenus()).toHaveLength(2))
      expect(fileMenus().map((b) => b.textContent)).toEqual(['settings.json', 'CLAUDE.md'])
      // A file the agent has not written yet is still offered, and says so on hover.
      expect(fileMenus()[1]?.getAttribute('title')).toContain('not created yet')
      expect(document.querySelector('[data-slot="account-open-folder"]')).not.toBeNull()
    })

    it('opens with the system default by ID — never by a path the client composed', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      await pickFrom(fileMenus()[0]!, 'system')
      await waitFor(() => expect(openBody()).toBeDefined())
      // No `target` at all is what "system default" means on the wire.
      expect(openBody()).toEqual({ file: 'claude.user.settings' })
      // The path is the server's to resolve; nothing path-shaped is sent.
      expect(JSON.stringify(openBody())).not.toContain('/')
    })

    it('lets you pick a detected editor instead of the system default', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      await pickFrom(fileMenus()[0]!, 'vscode')
      await waitFor(() => expect(openBody()).toBeDefined())
      expect(openBody()).toEqual({ file: 'claude.user.settings', target: 'vscode' })
    })

    it('never offers a target that cannot act on a FILE', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      fireEvent.pointerDown(fileMenus()[0]!)
      await waitFor(() => expect(document.querySelector('[data-target="vscode"]')).not.toBeNull())
      // `terminal` would `cd` into the file; a `cli:` handoff would start an agent session in the
      // config folder. The route refuses both — the menu must not offer them either.
      expect(document.querySelector('[data-target="terminal"]')).toBeNull()
      expect(document.querySelector('[data-target="cli:claude"]')).toBeNull()
      expect(document.querySelector('[data-target="finder"]')).toBeNull()
    })

    it('does offer the file manager and a terminal for the FOLDER', async () => {
      serve(withFiles() as never)
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() =>
        expect(document.querySelector('[data-slot="account-open-folder"]')).not.toBeNull(),
      )

      fireEvent.pointerDown(document.querySelector('[data-slot="account-open-folder"]')!)
      await waitFor(() => expect(document.querySelector('[data-target="finder"]')).not.toBeNull())
      expect(document.querySelector('[data-target="terminal"]')).not.toBeNull()
      // Still never an agent CLI: that opens a task worktree, not a config folder.
      expect(document.querySelector('[data-target="cli:claude"]')).toBeNull()
    })

    it("surfaces the server's refusal when a file is not there yet", async () => {
      serve(withFiles() as never, {
        openStatus: 409,
        openError: 'this account has no CLAUDE.md yet',
      })
      renderAccounts()
      await waitFor(() => expect(rows()).toHaveLength(1))
      fireEvent.click(toggle())
      await waitFor(() => expect(fileMenus()).toHaveLength(2))

      await pickFrom(fileMenus()[1]!, 'system')
      await waitFor(() =>
        expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain(
          'no CLAUDE.md yet',
        ),
      )
    })
  })

  /**
   * A cockpit newer than the server it is talking to — routine in development, where Vite serves
   * this bundle while `dist/` or a separate process serves the API. An additive field the server
   * has never heard of must degrade, not crash: `account.files.map` of undefined took the whole
   * pane down with a white screen.
   */
  it('survives a server that answers without the additive collections', async () => {
    serve({
      editable: true,
      profiles: [{
        id: 'default',
        provider: 'claude',
        label: 'Default',
        configDir: '/home/u/.claude',
        path: '/home/u/.claude',
        exists: true,
        looksValid: true,
        isDefault: true,
        status: { provider: 'claude', status: 'connected' },
        // No `files` — the field this pane crashed on.
      }],
      // No `profileCapableProviders`, no `selections` either.
    } as never)
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.click(document.querySelector('[data-action="account-details-toggle"]')!)

    // The panel renders, with no file buttons and the folder action still usable.
    await waitFor(() => expect(document.querySelector('[data-slot="account-details"]')).not.toBeNull())
    expect([...document.querySelectorAll('[data-slot="account-open-file"]')]).toHaveLength(0)
    expect(document.querySelector('[data-slot="account-open-folder"]')).not.toBeNull()
    // …and no Add button, because the server never said which providers can carry one.
    expect(document.querySelector('[data-action="accounts-add"]')).toBeNull()
  })

  it('withholds every path in hosted mode', async () => {
    serve({ editable: false, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: [] })
    renderAccounts()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="accounts-hosted"]')?.textContent).toContain(
        'hosted mode',
      ),
    )
    expect(rows()).toHaveLength(0)
    expect(document.querySelector('[data-action="accounts-add"]')).toBeNull()
  })

  it('gives every agent a tab, including one that cannot carry a second account', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    await waitFor(() => expect(rows()).toHaveLength(1))
    // OpenCode gets a tab too: it is where "is OpenCode installed?" is answered, and hiding it
    // would only move that question somewhere else.
    expect(
      [...document.querySelectorAll('[data-slot="accounts-tabs"] [data-provider]')].map((el) =>
        el.getAttribute('data-provider'),
      ),
    ).toEqual(['claude', 'codex', 'opencode'])
  })

  it('offers no Add on an agent that cannot carry a second account, and says why', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    await openTab('opencode')
    expect(document.querySelector('[data-action="accounts-add"]')).toBeNull()
    expect(document.querySelector('[data-slot="accounts-single-only"]')?.textContent).toContain(
      'credentials outside its config folder',
    )
  })

  it('reports what the MACHINE has for the active agent, not per account', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    // A version and an install belong to the BINARY: every login of one CLI shares them.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="agent-version"]')?.textContent).toBe('2.1.220'),
    )
    expect(document.querySelector('[data-slot="agent-installed"]')?.textContent).toBe('Yes')
  })

  it('names the install command for an agent that is not on this machine', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()

    await openTab('codex')
    expect(document.querySelector('[data-slot="agent-installed"]')?.textContent).toContain(
      '@openai/codex',
    )
    // No version row at all when there is nothing installed to have one.
    expect(document.querySelector('[data-slot="agent-version"]')).toBeNull()
  })
})

/**
 * "Add agent account". The folder is a TYPED field, not a browse-only selection, and that is the
 * whole point: every agent config folder is hidden, and the documented flow adds one that does
 * not exist yet — neither is reachable through a picker that only lists visible directories.
 */
describe('the add-account dialog', () => {
  const openDialog = async (provider = 'claude') => {
    if (provider !== 'claude') await openTab(provider);
    await waitFor(() => expect(document.querySelector('[data-action="accounts-add"]')).not.toBeNull())
    fireEvent.click(document.querySelector(`[data-action="accounts-add"][data-provider="${provider}"]`)!)
    await waitFor(() => expect(document.querySelector('[data-slot="add-account-dialog"]')).not.toBeNull())
  }
  const dirField = () => screen.getByLabelText<HTMLInputElement>('Config folder')
  const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-slot="add-account-confirm"]')!

  it('accepts a hand-typed `~` folder that does not exist yet', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()

    // Nothing browsed, nothing selected — just typed, which is the fast path.
    expect(confirmButton().disabled).toBe(true)
    fireEvent.change(dirField(), { target: { value: '~/.claude-second' } })
    expect(confirmButton().disabled).toBe(false)
    fireEvent.click(confirmButton())

    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
    // Sent as WRITTEN: the `~` is the server's to expand, and it stores the user's spelling.
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      provider: 'claude',
      configDir: '~/.claude-second',
    })
  })

  it('refuses an empty folder without sending anything', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()

    fireEvent.change(dirField(), { target: { value: '   ' } })
    expect(confirmButton().disabled).toBe(true)
    expect(requests.some((r) => r.method === 'POST')).toBe(false)
  })

  it('asks the browser for HIDDEN folders — otherwise it lists no candidate at all', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()

    // Collapsed by default: typing is the fast path, and no browse request has been made yet.
    expect(requests.some((r) => r.url.startsWith('/api/v1/fs/browse'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

    await waitFor(() => expect(requests.some((r) => r.url.startsWith('/api/v1/fs/browse'))).toBe(true))
    expect(requests.find((r) => r.url.startsWith('/api/v1/fs/browse'))?.url).toContain('showHidden=1')
    // …and the dotfolder the server returned is actually offered.
    expect(await screen.findByText('.claude-second')).not.toBeNull()
  })

  it('browsing FILLS the folder field rather than replacing it as a hidden selection', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

    fireEvent.click(await screen.findByText('.claude-second'))
    // The user can see, and still edit, exactly what will be submitted.
    await waitFor(() => expect(dirField().value).toBe('/home/u/.claude-second'))

    fireEvent.click(confirmButton())
    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      configDir: '/home/u/.claude-second',
    })
  })

  it('opens on the agent whose own Add button was clicked', async () => {
    serve({ editable: true, profileCapableProviders: ['claude', 'codex'],
      defaults: {},
      selections: {}, profiles: DEFAULTS })
    renderAccounts()
    await openDialog('codex')

    expect(screen.getByLabelText<HTMLSelectElement>('Agent').value).toBe('codex')
    // The placeholder follows too, so the example folder is not the wrong agent's. It stays a
    // GENERIC name — this string ships to every cezar user, so it must not carry one person's.
    expect(dirField().placeholder).toBe('~/.codex-second')
  })

  it("shows the server's refusal verbatim", async () => {
    serve(
      { editable: true, profileCapableProviders: ['claude', 'codex'],
        defaults: {},
      selections: {}, profiles: DEFAULTS },
      { createStatus: 409, createError: "that is already this agent's default folder" },
    )
    renderAccounts()
    await openDialog()

    fireEvent.change(dirField(), { target: { value: '~/.claude' } })
    fireEvent.click(confirmButton())

    await waitFor(() =>
      expect(document.querySelector('[data-slot="add-account-error"]')?.textContent).toBe(
        "that is already this agent's default folder",
      ),
    )
  })
})
