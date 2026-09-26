import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Skill, TrackerItem } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { TrackerHandoff } from './tracker-handoff'

vi.mock('@/components/engine-pills', () => ({
  EnginePills: () => null,
  engineRunBody: () => ({}),
  useResolvedEngine: () => ({ canRun: true }),
}))

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Tracker handoff', () => {
  it('requires a new acknowledgment when a refreshed lossy description changes, retaining the draft', () => {
    const client = createQueryClient()
    const view = (body: string) => <MemoryRouter><QueryClientProvider client={client}>
      <TrackerHandoff item={{ ...ITEM, body, bodyTruncated: true }} workflows={[]} skills={[]} />
    </QueryClientProvider></MemoryRouter>
    const rendered = render(view('Old partial description'))
    fireEvent.change(screen.getByLabelText('Custom instruction'), { target: { value: 'Keep this instruction' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
    expect((screen.getByRole('button', { name: /Run agent/ }) as HTMLButtonElement).disabled).toBe(false)
    rendered.rerender(view('Changed partial description'))
    expect((screen.getByRole('checkbox', { name: /I understand/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: /Run agent/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Custom instruction') as HTMLTextAreaElement).value).toBe('Keep this instruction')
  })

  it('disables a ninth skill and submits every selected skill without truncation', async () => {
    let submitted: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ id: 'run-1' }), { status: 200 })
    }))
    const skills: Skill[] = Array.from({ length: 9 }, (_, index) => ({
      name: `skill-${index + 1}`,
      description: '', body: '', path: `/skills/${index + 1}.md`, source: 'global',
    }))
    render(
      <MemoryRouter><QueryClientProvider client={createQueryClient()}>
        <TrackerHandoff item={ITEM} workflows={[]} skills={skills} />
      </QueryClientProvider></MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Choose skills' }))
    for (const skill of skills.slice(0, 8)) fireEvent.click(document.querySelector(`[data-skill="${skill.name}"]`)!)
    const ninth = document.querySelector(`[data-skill="${skills[8]!.name}"]`)!
    expect(ninth.getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(screen.getByPlaceholderText('search skills…'), { key: 'Escape' })
    expect(screen.getByText(/at most 8 skills/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Run agent/i }))

    await waitFor(() => expect(submitted).toBeDefined())
    expect((submitted?.steps as Array<{ skill: string }>).map((step) => step.skill))
      .toEqual(skills.slice(0, 8).map((skill) => skill.name))
  })
})

const ITEM: TrackerItem = {
  kind: 'issue', id: 'OPS-1', title: 'Keep every skill', author: 'Ada',
  createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
  labels: [], body: 'Full detail', bodyTruncated: false, unsupportedContent: false,
  url: 'https://acme.atlassian.net/browse/OPS-1', status: 'Open',
}

it('keyboard submission obeys the same snapshot acknowledgment guard as the button', async () => {
  const send = vi.fn(async () => new Response(JSON.stringify({ id: 'run-shortcut' }), { status: 200 }))
  vi.stubGlobal('fetch', send)
  render(<MemoryRouter><QueryClientProvider client={createQueryClient()}><TrackerHandoff item={{ ...ITEM, unsupportedContent: true }} workflows={[]} skills={[]} /></QueryClientProvider></MemoryRouter>)
  fireEvent.keyDown(screen.getByLabelText('Custom instruction'), { key: 'Enter', ctrlKey: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
  fireEvent.keyDown(screen.getByLabelText('Custom instruction'), { key: 'Enter', ctrlKey: true })
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
})
