import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { DEFAULT_PROMPT_TEMPLATES } from '@/lib/prompt-templates'
import { PromptTemplatesSection } from './prompt-templates-section'

/**
 * Settings → Prompt templates (#413): the round-trip against a stubbed `/api/v1/ui-state` — an
 * untouched repo shows the built-ins with nothing persisted yet, edits are local until Save,
 * and Save PUTs the whole `promptTemplates` array (the ui-state merge is shallow, same rule as
 * Appearance's accent/density PUT).
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** Two skills, deliberately global-first, so the project-first grouping rule (#377) is visible. */
const SKILLS = [
  { name: 'g-review', description: 'Global review', body: '', path: '/g/g-review', source: 'global' },
  { name: 'om-fix', description: 'Fix an issue', body: '', path: '/p/om-fix', source: 'ai' },
]

function serve(uiState: Record<string, unknown> = {}, skills: unknown[] = SKILLS) {
  requests = []
  // The skills picker is cmdk, which sizes its list with a ResizeObserver and scrolls the active
  // item into view; jsdom has neither (same stubs as command-palette.test.tsx / github.test.tsx).
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Element.prototype.scrollIntoView = vi.fn()
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      if (url.startsWith('/api/v1/skills')) return json(skills)
      return new Promise<never>(() => {})
    }),
  )
}

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <PromptTemplatesSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

const putBody = () =>
  requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/ui-state')?.body as
    | { promptTemplates?: unknown[] }
    | undefined
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="prompt-template-row"]')]
const saveButton = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-templates-save"]')!
const addButton = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-template-add"]')!
const resetButton = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-templates-reset"]')!

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the prompt templates section', () => {
  it('an untouched ui-state renders the built-in templates, Save disabled (nothing edited yet)', async () => {
    serve()
    renderSection()

    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))
    expect(rows().map((row) => row.dataset.template)).toEqual(
      DEFAULT_PROMPT_TEMPLATES.map((t) => t.id),
    )
    expect(saveButton().disabled).toBe(true)
  })

  it('a persisted custom list wins over the built-ins at boot', async () => {
    serve({ promptTemplates: [{ id: 'custom-1', label: 'My snippet', text: 'Custom instructions.' }] })
    renderSection()

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.dataset.template).toBe('custom-1')
  })

  it('editing a template label enables Save; Save PUTs the whole edited list', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    const firstLabelInput = rows()[0]!.querySelector<HTMLInputElement>(
      '[data-slot="prompt-template-label-input"]',
    )!
    fireEvent.change(firstLabelInput, { target: { value: 'Renamed template' } })
    expect(saveButton().disabled).toBe(false)

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeDefined())
    expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length)
    expect((putBody()?.promptTemplates?.[0] as { label: string }).label).toBe('Renamed template')
    expect(await screen.findByText('Prompt templates saved')).toBeTruthy()
  })

  it('removing a template drops its row and Save persists the shorter list', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    fireEvent.click(rows()[0]!.querySelector('[data-action="prompt-template-remove"]')!)
    expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length - 1)

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length - 1))
  })

  it('adding a template requires both a label and text before the Add button enables', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    expect(addButton().disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('New template label'), { target: { value: 'Ship it' } })
    expect(addButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('New template text'), {
      target: { value: 'Ship the change once green.' },
    })
    expect(addButton().disabled).toBe(false)

    fireEvent.click(addButton())
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length + 1))
    expect(screen.getByDisplayValue('Ship it')).toBeTruthy()
    // The mini-form clears after adding.
    expect(screen.getByLabelText('New template label')).toHaveProperty('value', '')

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length + 1))
  })

  it('clearing a label disables Save again and shows the "needs both" validation message', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    const firstLabelInput = rows()[0]!.querySelector<HTMLInputElement>(
      '[data-slot="prompt-template-label-input"]',
    )!
    fireEvent.change(firstLabelInput, { target: { value: '' } })
    expect(saveButton().disabled).toBe(true)
    expect(document.querySelector('[data-slot="prompt-templates-invalid"]')).not.toBeNull()
  })

  it('Reset to defaults restores the built-ins locally (still requires Save to persist)', async () => {
    serve({ promptTemplates: [{ id: 'custom-1', label: 'My snippet', text: 'Custom instructions.' }] })
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.click(resetButton())
    expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length)
    expect(saveButton().disabled).toBe(false) // differs from the persisted (custom) list

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()?.promptTemplates).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))
  })

  it('a PUT failure surfaces as a toast', async () => {
    requests = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/api/v1/ui-state' && method === 'GET')
          return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
        if (url === '/api/v1/ui-state' && method === 'PUT')
          return new Response(JSON.stringify({ error: 'disk full' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        return new Promise<never>(() => {})
      }),
    )
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    fireEvent.click(rows()[0]!.querySelector('[data-action="prompt-template-remove"]')!)
    fireEvent.click(saveButton())
    expect(await screen.findByText('disk full')).toBeTruthy()
  })
})

// ---- assigning templates to skills (#413 follow-up) ---------------------------------------------

describe('assigning a template to a skill', () => {
  const trigger = (row: HTMLElement) =>
    row.querySelector<HTMLButtonElement>('[data-slot="prompt-template-skills-trigger"]')!
  const option = (name: string) =>
    document.querySelector<HTMLElement>(`[data-slot="prompt-template-skill-option"][data-skill="${name}"]`)

  /** Open the picker. The trigger is disabled until /api/v1/skills answers, so wait it out first —
   *  a click on a disabled button is silently a no-op. */
  const openPicker = async (row: HTMLElement) => {
    await waitFor(() => expect(trigger(row).disabled).toBe(false))
    fireEvent.click(trigger(row))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="prompt-template-skill-option"]')).not.toBeNull(),
    )
  }

  /** Toggling keeps the popover open (multi-select), so only open when it is not already showing. */
  const assign = async (row: HTMLElement, name: string) => {
    if (option(name) === null) await openPicker(row)
    fireEvent.click(option(name)!)
  }

  it('lists skills project-first and bold, matching every other skill picker (#377)', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    await openPicker(rows()[0]!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-skill-option"]')).toHaveLength(2),
    )
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="prompt-template-skill-option"]')]
    // Served global-first; rendered project-first.
    expect(options.map((o) => o.dataset.skill)).toEqual(['om-fix', 'g-review'])
    expect(options[0]?.querySelector('.font-semibold')).not.toBeNull()
    expect(options[1]?.querySelector('.font-semibold')).toBeNull()
  })

  it('lists most-used skills first, across localities (#519)', async () => {
    // g-review is global but USED — it now leads the unused project skill om-fix.
    serve({ skillUsage: { 'g-review': 3 } })
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    await openPicker(rows()[0]!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-skill-option"]')).toHaveLength(2),
    )
    const options = [...document.querySelectorAll<HTMLElement>('[data-slot="prompt-template-skill-option"]')]
    expect(options.map((o) => o.dataset.skill)).toEqual(['g-review', 'om-fix'])
  })

  it('a query filters the Most used tier too — not just the rest of the catalog (#668)', async () => {
    // g-review is promoted into Most used by usage; a query for "fix" must still hide it.
    serve({ skillUsage: { 'g-review': 3 } })
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    await openPicker(rows()[0]!)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-skill-option"]')).toHaveLength(2),
    )

    const searchInput = document.querySelector<HTMLInputElement>('[placeholder="search skills…"]')!
    fireEvent.change(searchInput, { target: { value: 'fix' } })

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-skill-option"]')).toHaveLength(1),
    )
    expect(option('om-fix')).not.toBeNull()
    // The frequently-used g-review must be gone even though it sits in the Most used tier.
    expect(option('g-review')).toBeNull()
  })

  it('assigning shows a chip and Save PUTs the skills alongside the template', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    await assign(rows()[0]!, 'om-fix')
    await waitFor(() =>
      expect(rows()[0]!.querySelector('[data-slot="prompt-template-skill-chip"][data-skill="om-fix"]')).not.toBeNull(),
    )

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeDefined())
    expect(putBody()?.promptTemplates?.[0]).toMatchObject({ id: 'add-tests', skills: ['om-fix'] })
    // Only the edited row gains an assignment.
    expect(putBody()?.promptTemplates?.[1]).not.toHaveProperty('skills')
  })

  it('the chip unassigns, and doing so leaves NO empty skills key behind', async () => {
    serve({
      promptTemplates: [{ id: 'a', label: 'A', text: 'Do A.', skills: ['om-fix'] }],
    })
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.click(rows()[0]!.querySelector('[data-slot="prompt-template-skill-chip"]')!)
    await waitFor(() =>
      expect(rows()[0]!.querySelector('[data-slot="prompt-template-skill-chip"]')).toBeNull(),
    )

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeDefined())
    expect(putBody()?.promptTemplates?.[0]).toEqual({ id: 'a', label: 'A', text: 'Do A.' })
  })

  it('assign-then-unassign is not an edit — the form goes back to clean', async () => {
    serve({ promptTemplates: [{ id: 'a', label: 'A', text: 'Do A.' }] })
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(saveButton().disabled).toBe(true)

    await assign(rows()[0]!, 'om-fix')
    await waitFor(() => expect(saveButton().disabled).toBe(false))

    await assign(rows()[0]!, 'om-fix')
    // Back to `{id,label,text}` with no phantom `skills: []` making it look dirty forever.
    await waitFor(() => expect(saveButton().disabled).toBe(true))
  })

  it('a template can be assigned to several skills at once', async () => {
    serve({ promptTemplates: [{ id: 'a', label: 'A', text: 'Do A.' }] })
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(1))

    await assign(rows()[0]!, 'om-fix')
    await assign(rows()[0]!, 'g-review')

    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeDefined())
    expect(putBody()?.promptTemplates?.[0]).toMatchObject({ skills: ['om-fix', 'g-review'] })
  })

  it('says so, rather than rendering nothing, when there are no skills to assign', async () => {
    serve({}, [])
    renderSection()
    await waitFor(() => expect(rows()).toHaveLength(DEFAULT_PROMPT_TEMPLATES.length))

    await waitFor(() => expect(trigger(rows()[0]!).disabled).toBe(true))
    expect(trigger(rows()[0]!).textContent).toContain('no skills found')
  })
})
