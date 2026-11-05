import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfigBundle, ConfigBundlePreview } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { attachmentName, parseConfigBundle } from '@/api/transfer'
import { TransferSection } from './transfer-section'

/**
 * Global settings → Transfer (spec 2026-11-04-automations-and-config-export-import, §UI/UX).
 * The server is stubbed at `fetch`, so what these pin is the wire: which query the export sends,
 * which `selection`/`mapping`/`resolutions` each preview carries, and that Apply sends the digest
 * of the preview on screen.
 */

const BUNDLE: ConfigBundle = {
  format: 'cezar-config-bundle',
  version: 1,
  exportedAt: '2026-11-05T10:00:00.000Z',
  workspace: { systemPrompt: 'be brief' },
  projects: [
    { name: 'cezar', remote: 'github.com/open-mercato/cezar', config: { baseBranch: 'main' }, reminders: { secretNames: ['SENTRY_TOKEN'], tracker: 'jira' } },
    { name: 'scratch', config: { requiredChecks: ['npm test'] }, reminders: { secretNames: [] } },
  ],
  reminders: { workspaceSecretNames: ['OPENAI_API_KEY'] },
}

function plan(overrides: Partial<ConfigBundlePreview> = {}): ConfigBundlePreview {
  return {
    sections: [
      {
        id: 'workspace',
        kind: 'workspace',
        selected: true,
        changes: [{ key: 'systemPrompt', from: 'be verbose', to: 'be brief', action: 'keep', conflict: true }],
        runsCommands: false,
        issues: [],
      },
      {
        id: 'project:0:config',
        kind: 'config',
        projectIndex: 0,
        targetProjectId: 'p-cezar',
        selected: true,
        changes: [{ key: 'baseBranch', to: 'main', action: 'take', conflict: false }],
        runsCommands: false,
        issues: [],
      },
      {
        id: 'project:1:config',
        kind: 'config',
        projectIndex: 1,
        selected: false,
        changes: [{ key: 'requiredChecks', to: ['npm test'], action: 'take', conflict: false }],
        runsCommands: true,
        issues: [],
      },
    ],
    projects: [
      { index: 0, name: 'cezar', remote: 'github.com/open-mercato/cezar', targetProjectId: 'p-cezar', match: 'remote', reminders: { secretNames: ['SENTRY_TOKEN'], tracker: 'jira' } },
      { index: 1, name: 'scratch', match: 'unmatched', reminders: { secretNames: [] } },
    ],
    reminders: { workspaceSecretNames: ['OPENAI_API_KEY'] },
    importAllowed: true,
    planDigest: 'digest-1',
    ...overrides,
  }
}

type Call = { method: string; url: string; body?: Record<string, unknown> }
let calls: Call[] = []
let localHandoff = true
let previewAnswer: (body: Record<string, unknown>, n: number) => Response
let importAnswer: () => Response

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  calls = []
  localHandoff = true
  previewAnswer = (_body, n) => json(plan({ planDigest: `digest-${n}` }))
  importAnswer = () => json({ applied: ['workspace', 'project:0:config'] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      calls.push({ method, url, body })
      if (url === '/api/v1/health') return json({ capabilities: { localHandoff } })
      if (url === '/api/v1/projects') {
        return json({
          bootProject: 'p-cezar',
          projectsDir: '~/cezar/projects',
          projects: [
            { id: 'p-cezar', name: 'cezar', root: '/r/cezar', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
            { id: 'p-web', name: 'web', root: '/r/web', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
            { id: 'p-gone', name: 'gone', root: '/r/gone', addedAt: '', lastOpenedAt: '', source: 'local', status: 'missing' },
          ],
        })
      }
      if (url.startsWith('/api/v1/workspace/config-bundle?') || url === '/api/v1/workspace/config-bundle') {
        return new Response(JSON.stringify(BUNDLE), {
          headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="cezar-config-2026-11-05.json"' },
        })
      }
      if (url === '/api/v1/workspace/config-bundle/preview') {
        return previewAnswer(body!, calls.filter((c) => c.url === url).length)
      }
      if (url === '/api/v1/workspace/config-bundle/import') return importAnswer()
      return new Promise<never>(() => {})
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TransferSection />
    </QueryClientProvider>,
  )
}

const previews = () => calls.filter((c) => c.url === '/api/v1/workspace/config-bundle/preview')
const lastPreview = () => previews().at(-1)!.body!

async function pick(content: string, name = 'bundle.json') {
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('[data-slot="transfer-import-file"]')
    if (!el) throw new Error('no file input yet')
    return el
  })
  fireEvent.change(input, { target: { files: [new File([content], name, { type: 'application/json' })] } })
}

async function pickBundle() {
  await pick(JSON.stringify(BUNDLE))
  await screen.findByText('cezar · config')
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-section-id="${id}"]`)!

describe('export', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))
  })

  it('lists the present projects with the excluded list and downloads every project by default', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderSection()
    const boxes = await waitFor(() => {
      const found = document.querySelectorAll('[data-slot="transfer-export-project"]')
      expect(found).toHaveLength(2)
      return found
    })
    expect(boxes).toHaveLength(2)
    expect(screen.queryByText('gone')).toBeNull()
    expect(document.querySelector('[data-slot="transfer-excluded"]')!.textContent).toContain(
      'Not included: secret values, tracker connections, agent accounts, webhooks, paths',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(calls.find((c) => c.url.startsWith('/api/v1/workspace/config-bundle'))?.url).toBe('/api/v1/workspace/config-bundle')
  })

  it('sends only the ticked projects', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderSection()
    const web = await screen.findByRole('checkbox', { name: 'web' })
    fireEvent.click(web)
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/workspace/config-bundle?projects=p-cezar')).toBe(true),
    )
  })
})

describe('import preview', () => {
  it('renders sections with a key-level diff, the project mapping and the reminders', async () => {
    renderSection()
    await pickBundle()

    // The first preview leaves every choice to the server's defaults.
    expect(lastPreview()).toEqual({ bundle: BUNDLE })

    const diff = within(card('workspace')).getByText('systemPrompt').closest('li')!
    expect(diff.querySelector('[data-slot="transfer-change-from"]')!.textContent).toBe('"be verbose"')
    expect(diff.querySelector('[data-slot="transfer-change-to"]')!.textContent).toBe('"be brief"')
    expect(within(card('project:0:config')).getByText('(not set)')).toBeTruthy()

    const reminders = document.querySelector('[data-slot="transfer-reminders"]')!
    expect(reminders.textContent).toContain('Re-enter these secrets')
    expect(reminders.textContent).toContain('OPENAI_API_KEY')
    expect(reminders.textContent).toContain('SENTRY_TOKEN')
    expect(reminders.textContent).toContain('reconnect the jira tracker')

    const remote = document.querySelector('[data-slot="transfer-project"][data-match="remote"]')!
    expect(remote.textContent).toContain('(same remote)')
    expect(remote.querySelector('select')).toBeNull()
  })

  it('starts command sections unticked with a warning, and an explicit selection once touched', async () => {
    renderSection()
    await pickBundle()

    const commands = within(card('project:1:config'))
    expect(commands.getByText('runs shell commands')).toBeTruthy()
    expect((commands.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect((within(card('workspace')).getByRole('checkbox') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(commands.getByRole('checkbox'))
    await waitFor(() =>
      expect(lastPreview().selection).toEqual(['workspace', 'project:0:config', 'project:1:config']),
    )
  })

  it('acknowledges a command automation with create when its name is free, rename when taken', async () => {
    const row = { kind: 'schedule' as const, action: 'skip' as const, issues: [], warnings: [], runsCommands: true }
    previewAnswer = (_body, n) => json(plan({
      planDigest: `digest-${n}`,
      sections: [...plan().sections, {
        id: 'project:0:automations', kind: 'automations', projectIndex: 0, targetProjectId: 'p-cezar', selected: false,
        changes: [], runsCommands: true, issues: [],
        automations: [
          { ...row, index: 0, name: 'Lint', action: 'create' },
          { ...row, index: 1, name: 'Nightly', collision: { id: 'a1', name: 'Nightly' } },
        ],
      }],
    }))
    renderSection()
    await pickBundle()
    const accepts = await waitFor(() => {
      const found = document.querySelectorAll<HTMLInputElement>('[data-slot="transfer-automation-accept"]')
      if (found.length < 2) throw new Error('no automation rows yet')
      return found
    })
    fireEvent.click(accepts[0]!)
    await waitFor(() => expect(lastPreview().resolutions).toEqual({
      'project:0:automations': { automations: { 0: { action: 'create', acceptCommands: true } } },
    }))
    fireEvent.click(document.querySelectorAll<HTMLInputElement>('[data-slot="transfer-automation-accept"]')[1]!)
    await waitFor(() => expect((lastPreview().resolutions as any)['project:0:automations'].automations[1])
      .toEqual({ action: 'rename', acceptCommands: true }))
  })

  it('sends a conflict resolution when keep/take changes', async () => {
    renderSection()
    await pickBundle()
    fireEvent.change(screen.getByLabelText('systemPrompt: keep or take'), { target: { value: 'take' } })
    await waitFor(() =>
      expect(lastPreview().resolutions).toEqual({ workspace: { keys: { systemPrompt: 'take' } } }),
    )
  })

  it('maps an unmatched project, or skips it, through the request', async () => {
    renderSection()
    await pickBundle()
    const select = screen.getByLabelText('Import scratch into') as HTMLSelectElement
    // Registered, present projects plus Skip — a missing root is not a target.
    expect([...select.options].map((o) => o.textContent)).toEqual(['Choose a project…', 'cezar', 'web', 'Skip'])

    fireEvent.change(select, { target: { value: 'p-web' } })
    await waitFor(() => expect(lastPreview().mapping).toEqual({ 1: 'p-web' }))

    fireEvent.change(screen.getByLabelText('Import scratch into'), { target: { value: '__skip__' } })
    await waitFor(() => expect(lastPreview().mapping).toEqual({ 1: null }))
  })

  it('applies with the digest of the latest preview', async () => {
    renderSection()
    await pickBundle()
    fireEvent.change(screen.getByLabelText('systemPrompt: keep or take'), { target: { value: 'take' } })
    await waitFor(() => expect(previews()).toHaveLength(2))
    const apply = await screen.findByRole('button', { name: 'Apply selected (2)' })
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(apply)

    await screen.findByText(/Applied 2 sections/)
    const sent = calls.find((c) => c.url === '/api/v1/workspace/config-bundle/import')!.body!
    expect(sent.planDigest).toBe('digest-2')
    expect(sent.resolutions).toEqual({ workspace: { keys: { systemPrompt: 'take' } } })
  })

  it('shows a stale-preview 409 and previews again', async () => {
    importAnswer = () => json({ error: 'the project changed since the preview — review again' }, 409)
    renderSection()
    await pickBundle()
    fireEvent.click(await screen.findByRole('button', { name: 'Apply selected (2)' }))
    expect((await screen.findByRole('alert')).textContent).toBe('the project changed since the preview — review again')
    await waitFor(() => expect(previews()).toHaveLength(2))
  })

  it('blocks Apply while a ticked section has issues', async () => {
    previewAnswer = () =>
      json(plan({ sections: [{ ...plan().sections[0]!, issues: ['systemPrompt is too long'] }] }))
    renderSection()
    await pick(JSON.stringify(BUNDLE))
    await screen.findByText('systemPrompt is too long')
    expect((screen.getByRole('button', { name: 'Apply selected (1)' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('import errors', () => {
  it('shows one inline error and no preview for a newer file', async () => {
    renderSection()
    await pick(JSON.stringify({ ...BUNDLE, version: 2 }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'this file was written by a newer cezar (version 2); update cezar to import it',
    )
    expect(document.querySelector('[data-slot="transfer-preview"]')).toBeNull()
    expect(previews()).toHaveLength(0)
  })

  it('rejects a file that is not JSON', async () => {
    renderSection()
    await pick('{nope')
    expect((await screen.findByRole('alert')).textContent).toBe('this file is not JSON')
  })

  it('shows the server’s 400 inline with no preview', async () => {
    previewAnswer = () => json({ error: 'workspace.resources: invalid' }, 400)
    renderSection()
    await pick(JSON.stringify(BUNDLE))
    expect((await screen.findByRole('alert')).textContent).toBe('workspace.resources: invalid')
    expect(document.querySelector('[data-slot="transfer-preview"]')).toBeNull()
  })
})

describe('hosted cockpit', () => {
  it('replaces the Import half when the cockpit is not local', async () => {
    localHandoff = false
    renderSection()
    await screen.findByText('Import is only available on a local cockpit.')
    expect(document.querySelector('[data-slot="transfer-import-file"]')).toBeNull()
    // Export stays available in both modes.
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })

  it('replaces the Import half when the preview says import is not allowed', async () => {
    previewAnswer = () => json(plan({ importAllowed: false }))
    renderSection()
    await pick(JSON.stringify(BUNDLE))
    await screen.findByText('Import is only available on a local cockpit.')
  })
})

describe('the transfer api helpers', () => {
  it('reads the attachment filename, with a dated fallback', () => {
    expect(attachmentName('attachment; filename="cezar-config-x.json"')).toBe('cezar-config-x.json')
    expect(attachmentName(null, new Date('2026-11-05T12:00:00Z'))).toBe('cezar-config-2026-11-05.json')
  })

  it('names the wrong-format case before any other issue', () => {
    expect(parseConfigBundle(JSON.stringify({ format: 'cezar-automations', version: 1 }))).toEqual({
      ok: false,
      error: 'this is not a cezar configuration bundle',
    })
    expect(parseConfigBundle('  ')).toEqual({ ok: false, error: 'this file is empty' })
  })
})
