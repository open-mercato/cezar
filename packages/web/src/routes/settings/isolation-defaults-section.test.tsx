import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { IsolationDefaultsSection } from './isolation-defaults-section'
import { secretIdFor } from './secret-picker'

/**
 * Settings → Isolation defaults: the machine-wide answers a project inherits.
 *
 * What this pins: the isolation default is ONE three-state control (a deliberate
 * "do not isolate" survives being looked at), blur-committed inputs write only
 * when something changed, and the Vault picker neither spawns a `vault` per
 * keystroke nor dresses a refused browse up as an empty folder.
 */

const ISOLATION = {
  runtime: { ready: true, provider: 'podman', installed: true, machineRunning: true, reason: '' },
  enabled: false,
  effective: false,
  image: 'localhost/cezar-agent/base:latest',
  hasContainerfile: false,
  suggestions: [],
  resources: {},
  credentials: { catalog: [], enabled: {}, custom: [], own: { enabled: {}, custom: [] } },
}

type Browse = (mount: string, path: string) => Response

let puts: unknown[] = []
let browses: Array<{ mount: string; path: string }> = []

function json(body: unknown, code = 200) {
  return new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
}

function serve({
  agentDefaults = {},
  mounts = ['kv'],
  browse = () => json({ mount: 'kv', path: '', entries: [], fields: [] }),
}: {
  agentDefaults?: WorkspaceConfigResponse['agentDefaults']
  mounts?: string[]
  browse?: Browse
} = {}) {
  puts = []
  browses = []
  const state: WorkspaceConfigResponse = {
    branding: { name: 'cezar', logoUrl: null },
    agentDefaults,
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    resources: { maxParallel: 2, memoryLimitMb: null, worktreeRetentionDefault: 10 },
  } as WorkspaceConfigResponse
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(state)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        puts.push(JSON.parse(String(init?.body)))
        return json(state)
      }
      if (url.endsWith('/isolation')) return json(ISOLATION)
      if (url.endsWith('/vault/status')) {
        return json({
          installed: true,
          authenticated: true,
          reason: '',
          address: 'https://vault.test',
          mounts,
          ...(mounts.length === 0 ? { mountsError: 'permission denied' } : {}),
        })
      }
      if (url.includes('/vault/browse')) {
        const query = new URL(url, 'http://cockpit.test').searchParams
        const mount = query.get('mount') ?? ''
        const path = query.get('path') ?? ''
        browses.push({ mount, path })
        return browse(mount, path)
      }
      return new Promise<never>(() => {})
    }),
  )
}

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
})

function renderSection() {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IsolationDefaultsSection />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Isolation defaults: the machine-wide isolation default', () => {
  it('shows a deliberate "do not isolate" as itself, not as "no opinion"', async () => {
    serve({ agentDefaults: { isolation: false } })
    renderSection()
    const select = (await screen.findByRole('combobox', { name: 'Isolate agents by default' })) as HTMLSelectElement
    expect(select.value).toBe('false')
    // Exactly one control edits it — the second one used to write null for "off".
    expect(screen.getAllByLabelText('Isolate agents by default')).toHaveLength(1)
  })

  it('writes all three states, and only "no opinion" clears the key', async () => {
    serve()
    renderSection()
    const select = (await screen.findByRole('combobox', { name: 'Isolate agents by default' })) as HTMLSelectElement
    expect(select.value).toBe('unset')

    fireEvent.change(select, { target: { value: 'false' } })
    await waitFor(() => expect(puts).toHaveLength(1))
    fireEvent.change(select, { target: { value: 'true' } })
    await waitFor(() => expect(puts).toHaveLength(2))
    fireEvent.change(select, { target: { value: 'unset' } })
    await waitFor(() => expect(puts).toHaveLength(3))
    expect(puts).toEqual([
      { agentDefaults: { isolation: false } },
      { agentDefaults: { isolation: true } },
      { agentDefaults: { isolation: null } },
    ])
  })
})

describe('Isolation defaults: blur-committed fields', () => {
  it('tabbing through the container limits and the Vault address writes nothing', async () => {
    serve({
      agentDefaults: {
        sandbox: { resources: { memory: '4g', cpus: 2, shmSize: '1g' } },
        vault: { address: 'https://vault.test' },
      },
    })
    renderSection()
    for (const slot of ['defaults-memory', 'defaults-cpus', 'defaults-shm', 'vault-address', 'vault-namespace']) {
      const input = (await waitFor(() => {
        const found = document.querySelector(`[data-slot="${slot}"]`)
        if (!found) throw new Error(`no ${slot}`)
        return found
      })) as HTMLInputElement
      fireEvent.focus(input)
      fireEvent.blur(input)
    }
    // A write would invalidate the config and re-probe podman and Vault.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(puts).toEqual([])
  })

  it('a changed value is written once, on blur', async () => {
    serve({ agentDefaults: { sandbox: { resources: { memory: '4g' } }, vault: { address: 'https://vault.test' } } })
    renderSection()
    const memory = (await waitFor(() => {
      const found = document.querySelector('[data-slot="defaults-memory"]')
      if (!found) throw new Error('no memory input')
      return found
    })) as HTMLInputElement
    fireEvent.change(memory, { target: { value: '8g' } })
    fireEvent.blur(memory)
    await waitFor(() => expect(puts).toEqual([{ agentDefaults: { sandbox: { resources: { memory: '8g' } } } }]))

    const address = document.querySelector('[data-slot="vault-address"]') as HTMLInputElement
    fireEvent.change(address, { target: { value: '' } })
    fireEvent.blur(address)
    // Empty still CLEARS — a blank field must be able to remove an address.
    await waitFor(() => expect(puts.at(-1)).toEqual({ agentDefaults: { vault: { address: null } } }))
  })
})

describe('Isolation defaults: the Vault picker', () => {
  it('browses a typed mount once the operator stops typing, not per keystroke', async () => {
    serve({ mounts: [] })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a secret…' }))
    const mount = (await waitFor(() => {
      const found = document.querySelector('[data-slot="vault-mount"]')
      if (!found) throw new Error('no mount input')
      return found
    })) as HTMLInputElement
    for (const typed of ['s', 'se', 'sec', 'secr', 'secre', 'secret']) {
      fireEvent.change(mount, { target: { value: typed } })
    }
    // Every browse is a `vault` process on the host.
    expect(browses).toEqual([])
    await waitFor(() => expect(browses).toEqual([{ mount: 'secret', path: '' }]), { timeout: 2000 })
  })

  it('browses at once on Enter, and does not browse the same mount again on blur', async () => {
    serve({ mounts: [] })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a secret…' }))
    const mount = (await waitFor(() => {
      const found = document.querySelector('[data-slot="vault-mount"]')
      if (!found) throw new Error('no mount input')
      return found
    })) as HTMLInputElement
    fireEvent.change(mount, { target: { value: 'kv' } })
    fireEvent.keyDown(mount, { key: 'Enter' })
    await waitFor(() => expect(browses).toEqual([{ mount: 'kv', path: '' }]))
    fireEvent.blur(mount)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(browses).toHaveLength(1)
  })

  it('shows why a browse was refused instead of "Nothing here."', async () => {
    serve({ browse: () => json({ error: 'mount must be a KV mount name and path a KV path' }, 400) })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a secret…' }))
    expect(await screen.findByText(/mount must be a KV mount name and path a KV path/)).toBeTruthy()
    expect(screen.queryByText('Nothing here.')).toBeNull()
  })

  it('saves a deep path under a short id the settings route accepts, with the full reference', async () => {
    const folder = 'platform-team/production-environment/payments-service'
    serve({
      browse: (mount, path) => (path === ''
        ? json({ mount, path, entries: ['platform-team/'], fields: [] })
        : path === 'platform-team'
          ? json({ mount, path, entries: ['production-environment/'], fields: [] })
          : path === 'platform-team/production-environment'
            ? json({ mount, path, entries: ['payments-service'], fields: [] })
            : json({ mount, path, entries: [], fields: ['stripe_secret_key'] })),
    })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Add a secret…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'platform-team/' }))
    fireEvent.click(await screen.findByRole('button', { name: 'production-environment/' }))
    fireEvent.click(await screen.findByRole('button', { name: 'payments-service' }))
    fireEvent.click(await screen.findByRole('button', { name: 'stripe_secret_key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    const saved = (puts[0] as {
      agentDefaults: { sandbox: { credentials: { custom: Array<{ id: string; valueFrom: string }> } } }
    }).agentDefaults.sandbox.credentials.custom
    expect(saved).toHaveLength(1)
    expect(saved[0]?.valueFrom).toBe(`vault://kv/${folder}#stripe_secret_key`)
    expect(saved[0]?.id).toMatch(/^vault-[0-9a-f]{12}$/)
    expect(saved[0]?.id).toBe(secretIdFor('kv', folder, 'stripe_secret_key'))
  })
})

describe('secretIdFor', () => {
  it('keeps the readable id while it fits, so existing entries keep theirs', () => {
    expect(secretIdFor('kv', 'dev/api', 'token')).toBe('kv/dev/api#token')
    const fits = `kv/${'a'.repeat(64 - 'kv/#f'.length)}#f`
    expect(fits).toHaveLength(64)
    expect(secretIdFor('kv', 'a'.repeat(64 - 'kv/#f'.length), 'f')).toBe(fits)
  })

  it('hashes past 64 characters — stable, distinct, and within the cap', () => {
    const long = 'x'.repeat(80)
    const id = secretIdFor('kv', long, 'token')
    expect(id).toMatch(/^vault-[0-9a-f]{12}$/)
    expect(id.length).toBeLessThanOrEqual(64)
    // Re-picking the same key yields the same id, so it edits rather than duplicates.
    expect(secretIdFor('kv', long, 'token')).toBe(id)
    expect(secretIdFor('kv', long, 'other')).not.toBe(id)
  })
})
