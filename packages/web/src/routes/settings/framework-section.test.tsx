import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveFramework, FrameworkDetailResponse } from '@open-mercato/cezar-api-client'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { FrameworkSection } from './framework-section'

/** Settings → Project → Framework (spec 2026-11-15-framework-board, mockups 5–6). */

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

const DETAIL: FrameworkDetailResponse = {
  framework: {
    id: 'open-mercato-sdd',
    name: 'Open Mercato SDD',
    state: { command: 'node .ai/sdd/sdd.mjs status --json' },
    stages: [
      { id: 'discover', name: 'Discover', skill: 'om-sdd-discover', mode: 'conversation' },
      { id: 'spec', name: 'Spec', skill: 'om-sdd-spec', gate: { kind: 'framework', approve: 'spec' }, artifacts: ['.ai/specs/*/spec.md'] },
    ],
  },
  yaml: 'id: open-mercato-sdd\n',
  stages: [
    { stage: 'discover', kind: 'skill', name: 'om-sdd-discover', present: true },
    { stage: 'spec', kind: 'skill', name: 'om-sdd-spec', present: false },
  ],
  graph: { nodes: [], edges: [] },
  source: 'builtin',
}

let active: ActiveFramework
let puts: unknown[] = []
let installs: unknown[] = []
let installed = false
let installAnswer: () => Response
const INSTALL_INFO = {
  source: 'open-mercato/sdd',
  ref: '04ba2cc',
  writes: ['.claude/skills/om-sdd*/', '.ai/sdd/', '.ai/agentic.config.json'],
  currentBranch: 'main',
  baseBranch: 'main',
}

beforeEach(() => {
  puts = []
  installs = []
  installed = false
  installAnswer = () => {
    installed = true
    return json({ ok: true, changedPaths: ['.ai/sdd/sdd.mjs', '.claude/skills/om-sdd/SKILL.md'], committed: true, note: 'Committed on main.', output: 'Skills installed' })
  }
  active = { id: 'open-mercato-sdd', source: 'detected', detectedBy: '.ai/sdd/sdd.mjs' }
  setApiScope(null)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { framework: string | null }
        puts.push(body)
        active = body.framework ? { id: body.framework, source: 'explicit' } : { id: 'open-mercato-sdd', source: 'detected', detectedBy: '.ai/sdd/sdd.mjs' }
        return json({ active })
      }
      if (url.endsWith('/frameworks/open-mercato-sdd/install')) {
        installs.push(JSON.parse(String(init?.body)))
        return installAnswer()
      }
      if (url.endsWith('/frameworks/open-mercato-sdd')) return json(DETAIL)
      if (url.endsWith('/frameworks')) {
        return json({
          frameworks: [
            { id: 'generic', name: 'Generic', source: 'builtin', stages: [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }], availability: { found: 2, total: 2, installable: false } },
            {
              id: 'open-mercato-sdd',
              name: 'Open Mercato SDD',
              source: 'builtin',
              stages: [{ id: 'discover', name: 'Discover' }],
              availability: { found: installed ? 1 : 0, total: 1, installable: true },
              install: INSTALL_INFO,
            },
          ],
          active,
        })
      }
      return json({})
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function section(path = '/settings/framework') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <FrameworkSection />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const row = (id: string) => document.querySelector(`[data-framework-id="${id}"]`) as HTMLElement

describe('settings — framework', () => {
  it('marks the detected framework in use, and picking another writes an explicit choice', async () => {
    section()
    await screen.findByText('Generic')
    expect(within(row('open-mercato-sdd')).getByText('in use · detected')).toBeTruthy()
    expect(within(row('open-mercato-sdd')).getByText(/1 of 1 skills or commands not found/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to automatic' })).toBeNull()

    fireEvent.click(within(row('generic')).getByRole('button', { name: 'Use Generic' }))
    await waitFor(() => expect(puts).toEqual([{ framework: 'generic' }]))
    await waitFor(() => expect(within(row('generic')).getByText('in use · chosen')).toBeTruthy())
  })

  it('goes back to automatic with a null choice', async () => {
    active = { id: 'generic', source: 'explicit' }
    section()
    fireEvent.click(await screen.findByRole('button', { name: 'Back to automatic' }))
    await waitFor(() => expect(puts).toEqual([{ framework: null }]))
    await waitFor(() => expect(within(row('open-mercato-sdd')).getByText('in use · detected')).toBeTruthy())
  })

  it('installs a framework with missing skills: confirm, commit on the base branch, result, availability refreshed', async () => {
    section()
    await screen.findByRole('list', { name: 'Frameworks' })
    fireEvent.click(await within(row('open-mercato-sdd')).findByRole('button', { name: /Install into this repo/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('open-mercato/sdd')
    expect(dialog.textContent).toContain('04ba2cc')
    expect(within(dialog).getByText('.ai/sdd/')).toBeTruthy()
    const commit = within(dialog).getByRole('checkbox') as HTMLInputElement
    expect(commit.checked).toBe(true)
    expect(dialog.textContent).toContain('Commit on main')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('Open Mercato SDD installed')).toBeTruthy())
    expect(installs).toEqual([{ commit: true }])
    expect(screen.getByRole('dialog').textContent).toContain('Committed on main.')
    expect(screen.getByRole('dialog').textContent).toContain('.claude/skills/om-sdd/SKILL.md')
    expect(puts).toEqual([])

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(within(row('open-mercato-sdd')).getByText(/all skills and commands found/)).toBeTruthy())
    expect(within(row('open-mercato-sdd')).queryByRole('button', { name: /Install into this repo/ })).toBeNull()
  })

  it('“Install & use” chooses the framework after installing; an error stays inline', async () => {
    active = { id: 'generic', source: 'fallback' }
    let fail = true
    installAnswer = () => {
      if (fail) return new Response(JSON.stringify({ error: 'could not download open-mercato/sdd at 04ba2cc: offline' }), { status: 502, headers: { 'content-type': 'application/json' } })
      installed = true
      return json({ ok: true, changedPaths: [], committed: false, note: 'Left uncommitted.', output: '' })
    }
    section()
    await screen.findByRole('list', { name: 'Frameworks' })
    fireEvent.click(await within(row('open-mercato-sdd')).findByRole('button', { name: 'Install & use Open Mercato SDD' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install & use' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('offline')
    expect(puts).toEqual([])

    fail = false
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(puts).toEqual([{ framework: 'open-mercato-sdd' }]))
    expect(installs).toEqual([{ commit: false }, { commit: false }])
  })

  it('shows a framework’s stages with a missing skill in red, and its YAML', async () => {
    section('/settings/framework?framework=open-mercato-sdd')
    const table = await screen.findByRole('table')
    const spec = table.querySelector('[data-stage="spec"] [data-slot="stage-runs"]') as HTMLElement
    expect(spec.getAttribute('data-present')).toBe('false')
    expect(spec.textContent).toContain('missing in this repo')
    expect(table.querySelector('[data-stage="spec"]')!.textContent).toContain('⏸ framework approve spec')
    expect(document.querySelector('[data-slot="framework-yaml"]')!.textContent).toBe('id: open-mercato-sdd\n')
  })
})
