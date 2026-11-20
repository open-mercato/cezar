import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { AgentProfile, AgentProfilesResponse, Skill, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { AppRoutes } from '@/routes'
import { ThemeProvider } from '@/components/theme-provider'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const skillsUrl = '/api/v1/skills'
const account = (provider: AgentProfile['provider'], label = 'Default', id = 'default'): AgentProfile => ({
  id,
  provider,
  label,
  configDir: `~/.${provider}`,
  path: `/home/test/.${provider}`,
  exists: id === 'default',
  looksValid: id === 'default',
  isDefault: id === 'default',
  files: [],
})
const accounts: AgentProfilesResponse = {
  profiles: [account('claude'), account('codex'), account('claude', 'Work', 'work')],
  editable: true,
  profileCapableProviders: ['claude', 'codex'],
  defaults: {},
  selections: {},
}
const skill = (name: string, overrides: Partial<Skill> = {}): Skill => ({
  name, path: `${name}/SKILL.md`, body: '# Instructions', source: 'global', ...overrides,
})
const review = skill('om-auto-review-pr', {
  source: 'team',
  team: { repo: 'open-mercato/skills', ref: 'main', path: 'om-auto-review-pr/SKILL.md', dir: true },
  extension: { path: '.ai/skills/om-auto-review-pr/SKILL.md' },
})
const missingReview = skill(review.name, { source: 'ai', missingShared: true })

function serve({
  profiles = accounts,
  skills = [],
  ready = skills,
  refresh = () => skills,
}: {
  profiles?: AgentProfilesResponse | Error | null
  skills?: Skill[] | Error | null
  ready?: Skill[] | Error | null | Promise<Skill[]>
  refresh?: () => Skill[] | Error | null
} = {}) {
  requests = []
  const config: WorkspaceConfigResponse = {
    branding: { name: 'cezar', logoUrl: null },
    computerName: 'Test Mac',
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    orgSkillsRepos: [],
    systemPrompt: null,
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: false,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      idleTimeoutMinutes: 15,
      monitoringWakeIntervalMinutes: null,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10, worktreeIdleDaysDefault: 7, archivedTaskDeleteDaysDefault: 90, diskGuard: { minFreePercent: 10, minFreeGb: 5, maxWorktreesGb: 20 },
    },
    agentDefaults: {},
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const respond = (payload: unknown) => {
    if (payload === null) return new Promise<never>(() => {})
    if (payload instanceof Error) return json({ error: payload.message }, 400)
    return json(payload)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(config)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        if (body && 'skillsAutoUpdate' in body) {
          config.skillsAutoUpdate = body.skillsAutoUpdate as boolean | null
          config.effectiveSkillsAutoUpdate = config.skillsAutoUpdate ?? true
        }
        if (body && 'orgSkillsRepos' in body) config.orgSkillsRepos = body.orgSkillsRepos as typeof config.orgSkillsRepos
        return json(config)
      }
      if (url === '/api/v1/workspace/agent-profiles') return respond(profiles)
      if (url === skillsUrl) return respond(skills)
      if (url === `${skillsUrl}?wait=1`) return respond(await ready)
      if (url === `${skillsUrl}/refresh` && method === 'POST') return respond(refresh())
      return new Promise<never>(() => {})
    }),
  )
}

function renderSkills() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/settings/global/skills']}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  )
  return client
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const puts = () => requests.filter((request) => request.method === 'PUT')

describe('Global settings → Agents → Skill repositories', () => {
  it('renders the inherited auto-update default', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update Open Mercato skills automatically',
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('On (default)')).toBeTruthy()
    expect(screen.getByText(/CEZ_SKILLS_AUTO_UPDATE supplies/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Use default' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('writes an explicit boolean, then can clear it back to the inherited default', async () => {
    serve()
    renderSkills()
    const toggle = await screen.findByRole('switch', {
      name: 'Update Open Mercato skills automatically',
    })
    fireEvent.click(toggle)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: false }))
    const reset = screen.getByRole('button', { name: 'Use default' })
    await waitFor(() => expect((reset as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(reset)
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ skillsAutoUpdate: null }))
  })

  it('adds and removes an organisation skills repository', async () => {
    serve()
    renderSkills()
    const input = await screen.findByLabelText('Organisation skills repositories')
    fireEvent.change(input, { target: { value: 'acme/skills' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }))
    await waitFor(() =>
      expect(puts().at(-1)?.body).toEqual({ orgSkillsRepos: [{ repo: 'acme/skills', ref: 'main' }] }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Remove acme/skills' }))
    await waitFor(() => expect(puts().at(-1)?.body).toEqual({ orgSkillsRepos: [] }))
  })

  const availability = async () => within(await screen.findByRole('region', { name: 'Open Mercato skills for agent accounts' }))

  it('shows configured and discovered accounts with the same task catalog status', async () => {
    serve({ skills: [skill('om-code-review'), missingReview, skill('om-command', { kind: 'command' }), skill('custom')] })
    renderSkills()
    const region = await availability()
    await region.findByText('The catalog is missing shared skills for om-auto-review-pr.')
    const rows = region.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(region.getAllByText('Default')).toHaveLength(2)
    expect(region.getByText('Claude Code · Discovered')).toBeTruthy()
    expect(region.getByText('Codex · Discovered')).toBeTruthy()
    const work = within(region.getByText('Work').closest('li')!)
    expect(work.getByText('Claude Code')).toBeTruthy()
    expect(region.getAllByText('1 available · 1 missing')).toHaveLength(3)
    expect(region.getByText(/Tasks for these accounts use the default project’s skill catalog/)).toBeTruthy()
  })

  it('shows no availability when the catalog has only unrelated skills', async () => {
    serve({ skills: [skill('custom')] })
    renderSkills()
    expect(await (await availability()).findAllByText('No skills available')).toHaveLength(3)
  })

  it('shows loading and empty account states without blocking catalog repair', async () => {
    serve({ profiles: null })
    const client = renderSkills()
    const region = await availability()
    expect(region.getByText('Loading agent accounts…')).toBeTruthy()
    expect(region.queryByRole('listitem')).toBeNull()
    client.setQueryData(workspaceQueryKeys.agentProfiles, { ...accounts, profiles: [] })
    expect(await region.findByText(/No agent accounts found/)).toBeTruthy()
    expect((region.getByRole('button', { name: 'Repair skill catalog' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the shared catalog status when hosted account details are hidden', async () => {
    serve({ profiles: { ...accounts, profiles: [], editable: false }, skills: [review] })
    renderSkills()
    const region = await availability()
    expect(await region.findByText('Account details are hidden on this cockpit. 1 skill available')).toBeTruthy()
    expect(region.queryByRole('listitem')).toBeNull()
  })

  it('shows account loading errors within the skills card', async () => {
    serve({ profiles: new Error('Account listing unavailable') })
    renderSkills()
    const region = await availability()
    expect((await region.findByRole('alert')).textContent).toContain('Account listing unavailable')
    expect(region.queryByRole('listitem')).toBeNull()
  })

  it('shows that the skill catalog is still loading', async () => {
    serve({ skills: null })
    renderSkills()
    expect(await (await availability()).findAllByText('Checking skill catalog…')).toHaveLength(3)
  })

  it('shows unknown availability after a failed read and lets repair recover it', async () => {
    serve({ skills: new Error('Skill catalog unavailable'), refresh: () => [review] })
    renderSkills()
    const region = await availability()
    expect(await region.findAllByText('Availability unknown')).toHaveLength(3)
    expect(region.getByRole('alert').textContent).toContain('Skill catalog unavailable')
    fireEvent.click(region.getByRole('button', { name: 'Repair skill catalog' }))
    expect(await region.findAllByText('1 skill available')).toHaveLength(3)
    expect(region.queryByRole('alert')).toBeNull()
  })

  it('repairs the project catalog and updates both shared cache entries', async () => {
    let resolveReady!: (catalog: Skill[]) => void
    const ready = new Promise<Skill[]>((resolve) => { resolveReady = resolve })
    serve({ skills: [missingReview], ready, refresh: () => [review] })
    const client = renderSkills()
    const region = await availability()
    await region.findByText('The catalog is missing shared skills for om-auto-review-pr.')
    await waitFor(() => expect(requests.some(({ url }) => url === `${skillsUrl}?wait=1`)).toBe(true))
    fireEvent.click(region.getByRole('button', { name: 'Repair skill catalog' }))
    expect(await region.findAllByText('1 skill available')).toHaveLength(3)
    expect(region.queryByText(/The catalog is missing shared skills/)).toBeNull()
    expect(requests.filter(({ method }) => method === 'POST')).toEqual([{ method: 'POST', url: `${skillsUrl}/refresh` }])
    await act(async () => resolveReady([missingReview]))
    expect(client.getQueryData(queryKeys.skills)).toEqual([review])
    expect(client.getQueryData(queryKeys.skillsReady)).toEqual([review])
  })

  it('keeps the previous status on repair failure and reports skills still missing after a retry', async () => {
    const refresh = vi.fn().mockReturnValueOnce(new Error('Could not reach the skills repository')).mockReturnValue([missingReview])
    serve({ skills: [missingReview], refresh })
    renderSkills()
    const region = await availability()
    await region.findAllByText('No skills available')
    fireEvent.click(region.getByRole('button', { name: 'Repair skill catalog' }))
    expect((await region.findByRole('alert')).textContent).toContain('Could not reach the skills repository')
    expect(region.getAllByText('No skills available')).toHaveLength(3)
    fireEvent.click(region.getByRole('button', { name: 'Repair skill catalog' }))
    expect(await region.findByText('Catalog refreshed. No Open Mercato skills are available.')).toBeTruthy()
    expect(region.queryByRole('alert')).toBeNull()
    expect(region.getByText('The catalog is missing shared skills for om-auto-review-pr.')).toBeTruthy()
  })
})
