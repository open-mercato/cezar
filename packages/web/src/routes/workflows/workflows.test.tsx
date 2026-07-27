import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { Skill, WorkflowDef, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { WorkflowsRoute } from './workflows'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures ----------------------------------------------------------------------------------

const SKILLS: Skill[] = [
  { name: 'om-fix', description: 'Fix the thing', body: '', path: '.ai/skills/om-fix.md', source: 'ai' },
  { name: 'om-review', description: 'Review it', body: '', path: '~/.cez/skills/om-review.md', source: 'global' },
]

const QUICK: WorkflowDef = {
  name: 'quick-task',
  description: 'One agent run on your task — no ceremony.',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
}

/** The repo's first saved (file) workflow — what a cold /workflows visit must open. */
const SHIP: WorkflowDef = {
  name: 'ship-it',
  description: 'Fix then review.',
  source: 'file',
  path: '.ai/cezar/workflows/ship-it.yaml',
  steps: [
    { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
    { id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' },
  ],
}

/** Already at the server's save/run cap. */
const FULL: WorkflowDef = {
  name: 'crowded',
  source: 'file',
  path: '.ai/cezar/workflows/crowded.yaml',
  steps: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i + 1}`,
    name: 'om-fix',
    skill: 'om-fix',
    prompt: '{{task}}',
  })),
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (inbox.test.tsx): records requests (bodies included), serves
 *  the fixtures, and lets a test override specific `METHOD path` keys — per call, so a 409
 *  can turn into a 201 on the retry. */
function stubFetch(
  overrides: Record<string, Array<() => Response>> = {},
  workflows: WorkflowDef[] = [QUICK, SHIP],
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const queue = overrides[`${method} ${path}`]
      const next = queue?.shift()
      if (next) return next()
      if (method === 'GET' && path === '/api/v1/workflows') {
        return jsonResponse({ workflows, issues: [] } satisfies WorkflowsResponse)
      }
      if (method === 'GET' && path === '/api/v1/skills') return jsonResponse(SKILLS)
      if (method === 'GET' && path === '/api/v1/ui-state') return jsonResponse({})
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/workflows" element={<WorkflowsRoute />} />
          <Route path="/workflows/:name" element={<WorkflowsRoute />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const stepCards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="wb-step"]')]
const stepIds = () => stepCards().map((card) => card.dataset.id)
const yamlText = () => document.querySelector('[data-slot="wb-yaml"]')?.textContent ?? ''
const nameInput = () => screen.getByLabelText('Workflow name') as HTMLInputElement
const addButton = (skill: string) =>
  document.querySelector<HTMLButtonElement>(`[data-slot="wb-skill"][data-skill="${skill}"] [data-slot="wb-skill-add"]`)!

// ---- seeding -----------------------------------------------------------------------------------

describe('canvas seeding', () => {
  it('a cold /workflows opens the repo’s first saved workflow (built-ins skipped)', async () => {
    stubFetch()
    renderAt('/workflows')

    await waitFor(() => expect(stepIds()).toEqual(['om-fix', 'om-review']))
    expect(nameInput().value).toBe('ship-it')
    // Its chip reads active; the compact YAML preview reflects the pure stack.
    expect(
      document.querySelector('[data-slot="wb-load-chip"][data-name="ship-it"]')?.getAttribute('aria-pressed'),
    ).toBe('true')
    expect(yamlText()).toContain('skills:')
    expect(yamlText()).toContain('- om-fix')
    expect(screen.getByText('2 skills')).toBeTruthy()
  })

  it('/workflows/:name deep-links that workflow into the canvas', async () => {
    stubFetch({}, [QUICK, SHIP, FULL])
    renderAt('/workflows/crowded')

    await waitFor(() => expect(stepCards()).toHaveLength(8))
    expect(nameInput().value).toBe('crowded')
  })

  it('no saved workflows → an empty canvas with the drop hint', async () => {
    stubFetch({}, [QUICK])
    renderAt('/workflows')

    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
    expect(stepCards()).toHaveLength(0)
    expect(nameInput().value).toBe('my-workflow')
  })
})

// ---- palette → canvas, remove, limit -----------------------------------------------------------

describe('palette add / remove / the 8-step limit', () => {
  it('the palette add appends a step, dedupes ids, and updates count + YAML', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(addButton('om-fix'))
    expect(stepIds()).toEqual(['om-fix', 'om-review', 'om-fix-2'])
    expect(screen.getByText('3 skills')).toBeTruthy()
    expect(yamlText().match(/- om-fix/g)).toHaveLength(2)
  })

  it('remove drops exactly that card', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(screen.getByLabelText('Remove step 1: om-fix'))
    expect(stepIds()).toEqual(['om-review'])
    expect(screen.getByText('1 skill')).toBeTruthy()
  })

  it('the 9th step is refused with the legacy message', async () => {
    stubFetch({}, [FULL])
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(8))

    fireEvent.click(addButton('om-review'))
    expect(stepCards()).toHaveLength(8)
    await screen.findByText('A workflow holds at most 8 steps.')
  })

  // #374: the palette's empty state must mention the same discovery dirs as the Skills tab's,
  // not just `.ai/skills/`.
  it('an empty skill catalog explains every discovery dir, not just .ai/skills/', async () => {
    stubFetch({ 'GET /api/v1/skills': [() => jsonResponse([])] })
    renderAt('/workflows')

    const hint = await screen.findByText(/No skills yet/)
    expect(hint.textContent).toContain('.ai/skills/')
    expect(hint.textContent).toContain('.ai/cezar/skills/')
    expect(hint.textContent).toContain('.agents/skills/')
  })
})

// ---- import ------------------------------------------------------------------------------------

describe('YAML import', () => {
  it('a valid paste replaces the canvas with the server-normalized steps', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows/parse': [
        () =>
          jsonResponse({
            name: 'imported-flow',
            steps: [{ id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' }],
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), {
      target: { value: 'name: imported-flow\nskills:\n  - om-review\n' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['om-review']))
    expect(nameInput().value).toBe('imported-flow')
    // The server owns YAML parsing — the paste went to /parse verbatim.
    expect(sent.find((r) => r.path === '/api/v1/workflows/parse')?.body).toEqual({
      yaml: 'name: imported-flow\nskills:\n  - om-review',
    })
    await screen.findByText('Imported "imported-flow" — review, then Save.')
  })

  it('a bad paste surfaces the server’s own error and keeps the canvas', async () => {
    stubFetch({
      'POST /api/v1/workflows/parse': [
        () => jsonResponse({ error: 'a workflow lists either "steps" or "skills", not both' }, 400),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), { target: { value: 'nope: 1' } })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="wb-import-error"]')?.textContent).toBe(
        'a workflow lists either "steps" or "skills", not both',
      ),
    )
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
  })
})

// ---- auto chain creator (#414) -----------------------------------------------------------------

describe('auto chain creator', () => {
  it('a built plan lands its title + steps on the canvas', async () => {
    const sent = stubFetch({
      'POST /api/v1/plan': [
        () =>
          jsonResponse({
            name: 'fix-and-review',
            steps: [
              { id: 'implement', name: 'Implement', prompt: '{{task}}' },
              { id: 'verify', name: 'Verify', command: 'npm test' },
            ],
            rationale: 'implement then verify',
            fallback: false,
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), {
      target: { value: 'Fix the bug and review it' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-auto-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['implement', 'verify']))
    expect(nameInput().value).toBe('fix-and-review')
    expect(sent.find((r) => r.path === '/api/v1/plan')?.body).toEqual({ task: 'Fix the bug and review it' })
    await screen.findByText('Built "fix-and-review" — review, tweak, then Save.')
  })

  it('a degraded (fallback) plan keeps the current name and warns', async () => {
    stubFetch({
      'POST /api/v1/plan': [
        () =>
          jsonResponse({
            steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
            rationale: 'planner unavailable',
            fallback: true,
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), {
      target: { value: 'do something' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-auto-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['task']))
    // No proposed title → the name the canvas already had (the seeded file) survives.
    expect(nameInput().value).toBe('ship-it')
    await screen.findByText('Planner unavailable — added a single step. Edit, then Save.')
  })
})

// ---- save --------------------------------------------------------------------------------------

describe('save', () => {
  it('a pure stack saves in the portable compact form', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows': [
        () => jsonResponse({ path: '.ai/cezar/workflows/ship-it.yaml', name: 'ship-it' }, 201),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('Saved — ship-it.yaml')
    expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/workflows')?.body).toEqual({
      name: 'ship-it',
      description: 'Fix then review.',
      skills: ['om-fix', 'om-review'],
    })
  })

  it('a 409 opens the overwrite confirm; confirming retries with overwrite: true', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows': [
        () => jsonResponse({ error: 'workflow file already exists', exists: true }, 409),
        () => jsonResponse({ path: '.ai/cezar/workflows/ship-it.yaml', name: 'ship-it' }, 201),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('“ship-it” already exists')
    fireEvent.click(document.querySelector('[data-slot="wb-overwrite-confirm"]')!)

    await screen.findByText('Saved — ship-it.yaml')
    const posts = sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/workflows')
    expect(posts).toHaveLength(2)
    expect(posts[0]!.body).not.toHaveProperty('overwrite')
    expect(posts[1]!.body).toMatchObject({ name: 'ship-it', overwrite: true })
  })

  it('an empty canvas refuses to save with the legacy message', async () => {
    const sent = stubFetch({}, [QUICK])
    renderAt('/workflows')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('Add at least one step first.')
    expect(sent.some((r) => r.method === 'POST')).toBe(false)
  })
})

// ---- delete / new ------------------------------------------------------------------------------

describe('delete and “+ new”', () => {
  it('Delete exists only for saved files, confirms, DELETEs and resets the canvas', async () => {
    const sent = stubFetch({
      'DELETE /api/v1/workflows/ship-it': [
        () => jsonResponse({ ok: true, path: '.ai/cezar/workflows/ship-it.yaml' }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-delete"]')!)
    await screen.findByText('Delete workflow “ship-it”?')
    fireEvent.click(document.querySelector('[data-slot="wb-delete-confirm"]')!)

    await screen.findByText('Deleted "ship-it".')
    expect(sent.some((r) => r.method === 'DELETE' && r.path === '/api/v1/workflows/ship-it')).toBe(true)
    await waitFor(() => expect(stepCards()).toHaveLength(0))
    expect(nameInput().value).toBe('my-workflow')
  })

  it('a built-in (or unsaved) name shows no Delete button', async () => {
    stubFetch({}, [QUICK])
    renderAt('/workflows')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
    expect(document.querySelector('[data-slot="wb-delete"]')).toBeNull()
  })

  it('“+ new” resets to the empty draft', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-new"]')!)
    expect(stepCards()).toHaveLength(0)
    expect(nameInput().value).toBe('my-workflow')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
  })
})
