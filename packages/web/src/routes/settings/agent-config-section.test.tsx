import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AgentConfigFile, AgentConfigListing } from '@open-mercato/cezar-api-client'
import { Toaster } from '@/components/ui/toaster'
import { AgentConfigSection } from './agent-config-section'

/**
 * Settings → Agent config (#404, per-agent regrouping per spec
 * 2026-07-17-agent-config-by-agent): the SURFACE honoring the API contract
 * (pinned server-side in src/server/agent-config-api.test.ts). Covers the agent
 * selector, per-agent grouping (incl. shared files under every reader and the
 * MCP subsection with Claude's read-only user scopes), the vendor precedence
 * string, the read-only hosted render, and a save round-trip.
 */

function fileOf(over: Partial<AgentConfigFile> & Pick<AgentConfigFile, 'id' | 'label'>): AgentConfigFile {
  return {
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    format: 'json',
    tracked: 'tracked',
    seeded: false,
    holdsMcp: false,
    precedence: 'Overrides user settings key by key.',
    docsUrl: 'https://code.claude.com/docs/en/settings',
    path: `/repo/${over.label}`,
    exists: true,
    size: 10,
    version: 'v1',
    writable: true,
    ...over,
  }
}

const HEALTH = {
  version: '0.0.0',
  repoRoot: '/repo',
  repo: null,
  checks: [{ name: 'claude', available: true }],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true },
}

function serve(listing: AgentConfigListing, fileContent = '{"a":1}') {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/v1/health')) return json(HEALTH)
      if (url.endsWith('/api/v1/agent-config')) return json(listing)
      if (url.includes('/api/v1/agent-config/') && method === 'GET') {
        return json({ id: 'x', path: '/repo/x', exists: true, content: fileContent, version: 'v1' })
      }
      if (url.includes('/api/v1/agent-config/') && method === 'PUT') {
        return json({ id: 'x', path: '/repo/x', exists: true, content: '{"a":2}', version: 'v2' })
      }
      return json({ error: 'unexpected' }, 500)
    }),
  )
}

function renderSection() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AgentConfigSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

function agentTab(agent: string): HTMLElement {
  const el = document.querySelector(`[data-slot="agent-config-agent"][data-agent="${agent}"]`)
  expect(el).toBeTruthy()
  return el as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentConfigSection', () => {
  it('renders the agent selector with a not-installed badge from health', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(agentTab('claude')).toBeTruthy())
    expect(agentTab('claude').getAttribute('data-selected')).toBe('true')
    // health only reports claude available — the other two carry the badge
    await waitFor(() => expect(agentTab('codex').textContent).toContain('not installed'))
    expect(agentTab('opencode').textContent).toContain('not installed')
    expect(agentTab('claude').textContent).not.toContain('not installed')
  })

  it('shows only the selected agent’s files and swaps panes on switch', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
        fileOf({ id: 'codex.project.config', label: '.codex/config.toml', runners: ['codex'], format: 'toml', holdsMcp: true }),
      ],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    expect(screen.queryByText('.codex/config.toml')).toBeNull()

    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(screen.getAllByText('.codex/config.toml').length).toBeGreaterThan(0))
    expect(screen.queryByText('.claude/settings.json')).toBeNull()
    // the config.toml holds Codex's MCP servers — it must appear under Settings AND MCP
    const groups = [...document.querySelectorAll('[data-slot="agent-config-group"]')].map((el) =>
      el.getAttribute('data-group'),
    )
    expect(groups).toContain('settings')
    expect(groups).toContain('mcp')
    expect(screen.getAllByText('.codex/config.toml').length).toBe(2)
  })

  it('a file read by several agents appears under every one of them (runners[], not runners[0])', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'project.agents', label: 'AGENTS.md', runners: ['codex', 'opencode'], kind: 'memory', format: 'markdown' })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(agentTab('codex')).toBeTruthy())
    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(screen.getByText('AGENTS.md')).toBeTruthy())
    fireEvent.click(agentTab('opencode'))
    await waitFor(() => expect(screen.getByText('AGENTS.md')).toBeTruthy())
  })

  it('Claude’s MCP group lists the user/local scopes read-only', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.mcp', label: '.mcp.json', kind: 'mcp', holdsMcp: true })],
      userMcp: { path: '~/.claude.json', servers: ['github', 'sentry'], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.mcp.json')).toBeTruthy())
    const block = document.querySelector('[data-slot="agent-config-user-mcp"]')!
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('github')
    expect(block.textContent).toContain('sentry')
    expect(block.textContent).toContain('cezar does not edit')
    // the block belongs to Claude's pane only
    fireEvent.click(agentTab('codex'))
    await waitFor(() => expect(document.querySelector('[data-slot="agent-config-user-mcp"]')).toBeNull())
  })

  it('a file selection never survives an agent switch', async () => {
    serve({
      editable: true,
      files: [
        fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' }),
        fileOf({ id: 'opencode.project.config', label: 'opencode.json', runners: ['opencode'], holdsMcp: true }),
      ],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByLabelText('.claude/settings.json contents')).toBeTruthy())
    fireEvent.click(agentTab('opencode'))
    await waitFor(() => expect(screen.queryByLabelText('.claude/settings.json contents')).toBeNull())
    expect(screen.getByText('Select a config file to view or edit it.')).toBeTruthy()
  })

  it('shows the vendor precedence when a file is selected', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByText(/Overrides user settings key by key/)).toBeTruthy())
  })

  it('renders read-only in hosted mode — no Save button', async () => {
    serve({
      editable: false,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json', writable: false })],
      userMcp: null,
    })
    renderSection()
    await waitFor(() => expect(screen.getByText(/Read-only/)).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    await waitFor(() => expect(screen.getByLabelText('.claude/settings.json contents')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('saves an edited file', async () => {
    serve({
      editable: true,
      files: [fileOf({ id: 'claude.project.settings', label: '.claude/settings.json' })],
      userMcp: { path: '~/.claude.json', servers: [], readable: true },
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('.claude/settings.json')).toBeTruthy())
    fireEvent.click(screen.getByText('.claude/settings.json'))
    const editor = (await screen.findByLabelText('.claude/settings.json contents')) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '{"a":2}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/Saved/)).toBeTruthy())
  })
})
