import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiScope, type TaskTag } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { TaskTagsSection } from './task-tags-section'

// Radix Select in jsdom: no scrollIntoView, no ResizeObserver.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

const T = (id: string, name: string, extra: Partial<TaskTag> = {}): TaskTag => ({ id, name, createdAt: '2026-11-01T00:00:00Z', ...extra })
const TAGS: TaskTag[] = [
  T('tt-aaaaaaaa', 'urgent'),
  T('tt-bbbbbbbb', 'backend', { projectId: 'shop', color: 'blue', description: 'API work' }),
  T('tt-cccccccc', 'ghost', { projectId: 'gone', orphaned: true }),
  T('tt-dddddddd', 'loose', { projectId: 'nameless' }),
]

function setup(options: { tags?: TaskTag[]; patchStatus?: number; postStatus?: number } = {}) {
  const { tags = TAGS, patchStatus = 200, postStatus = 201 } = options
  const calls: { method: string; url: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    if (url.includes('/projects')) {
      return new Response(JSON.stringify({ projects: [{ id: 'shop', name: 'Shop', root: '/s', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' }] }), { status: 200 })
    }
    if (method === 'GET') return new Response(JSON.stringify({ tags, deletedIds: [] }), { status: 200 })
    if (method === 'POST') {
      if (postStatus !== 201) return new Response(JSON.stringify({ error: 'a tag named that already exists' }), { status: postStatus })
      const body = JSON.parse(String(init?.body)) as { name: string; projectId?: string }
      return new Response(JSON.stringify({ tag: T('tt-eeeeeeee', body.name, body.projectId ? { projectId: body.projectId } : {}) }), { status: 201 })
    }
    if (method === 'DELETE') return new Response(JSON.stringify({ deleted: true }), { status: 200 })
    if (patchStatus !== 200) return new Response(JSON.stringify({ error: 'a tag named that already exists' }), { status: patchStatus })
    return new Response(JSON.stringify({ tag: tags[0] }), { status: 200 })
  }))
  render(<QueryClientProvider client={createQueryClient()}><TaskTagsSection /></QueryClientProvider>)
  return calls
}
const patches = (calls: ReturnType<typeof setup>) => calls.filter((c) => c.method === 'PATCH')
const posts = (calls: ReturnType<typeof setup>) => calls.filter((c) => c.method === 'POST')

describe('Task tags settings', () => {
  it('groups Global, then projects by name, then the unregistered ones', async () => {
    setup()
    await screen.findByDisplayValue('urgent')
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(titles).toEqual(['Global', 'Shop', 'nameless', 'Unregistered project'])
    expect(screen.getAllByRole('button', { name: 'Make global' })).toHaveLength(3)
  })

  it('shows the empty state', async () => {
    setup({ tags: [] })
    await screen.findByText('No task tags yet')
  })

  it('renames on Enter, cancels on Escape', async () => {
    const calls = setup()
    const input = await screen.findByLabelText('Name of urgent')
    fireEvent.change(input, { target: { value: 'asap' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect((input as HTMLInputElement).value).toBe('urgent')
    expect(patches(calls)).toHaveLength(0)
    fireEvent.change(input, { target: { value: 'asap' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(patches(calls)).toHaveLength(1))
    expect(patches(calls)[0]!.body).toEqual({ name: 'asap' })
  })

  it('shows a rename conflict inline and restores the name', async () => {
    setup({ patchStatus: 409 })
    const input = await screen.findByLabelText('Name of urgent')
    fireEvent.change(input, { target: { value: 'backend' } })
    fireEvent.blur(input)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('already exists')
    expect((input as HTMLInputElement).value).toBe('urgent')
  })

  it('clears a description with null', async () => {
    const calls = setup()
    const input = await screen.findByLabelText('Description of backend')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    await waitFor(() => expect(patches(calls)).toHaveLength(1))
    expect(patches(calls)[0]!.body).toEqual({ description: null })
  })

  it('changes the color from the swatch menu', async () => {
    const calls = setup()
    const swatch = await screen.findByRole('button', { name: /Color of urgent/ })
    fireEvent.pointerDown(swatch, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'violet' }))
    await waitFor(() => expect(patches(calls)).toHaveLength(1))
    expect(patches(calls)[0]!.body).toEqual({ color: 'violet' })
  })

  it('makes a project tag global', async () => {
    const calls = setup()
    await screen.findByDisplayValue('backend')
    fireEvent.click(screen.getAllByRole('button', { name: 'Make global' })[0]!)
    await waitFor(() => expect(patches(calls)).toHaveLength(1))
    expect(patches(calls)[0]!.body).toEqual({ global: true })
    expect(patches(calls)[0]!.url).toContain('tt-bbbbbbbb')
  })

  it('deletes only after the confirmation, which names the consequence', async () => {
    const calls = setup()
    await screen.findByDisplayValue('urgent')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!)
    await screen.findByText(/disappears from every task/)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete tag' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
  })

  it('adds a global tag from Settings', async () => {
    const calls = setup()
    await screen.findByDisplayValue('urgent')
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: '  release  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(posts(calls)[0]!.url).toContain('/workspace/task-tags')
    expect(posts(calls)[0]!.body).toEqual({ name: 'release' })
    await waitFor(() => expect(screen.queryByLabelText('New tag name')).toBeNull())
  })

  it('adds a project tag when a project scope is picked', async () => {
    const calls = setup()
    await screen.findByDisplayValue('urgent')
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: 'review' } })
    fireEvent.keyDown(screen.getByLabelText('New tag scope'), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Shop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(posts(calls)[0]!.body).toEqual({ name: 'review', projectId: 'shop' })
  })

  it('offers Add tag in the empty state and keeps the form open on a conflict', async () => {
    const calls = setup({ tags: [], postStatus: 409 })
    await screen.findByText('No task tags yet')
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: 'urgent' } })
    fireEvent.keyDown(screen.getByLabelText('New tag name'), { key: 'Enter' })
    fireEvent.submit(screen.getByLabelText('New tag name').closest('form')!)
    await screen.findByRole('alert')
    expect(posts(calls)).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('already exists')
    expect(screen.getByLabelText('New tag name')).toBeTruthy()
  })
})
