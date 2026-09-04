import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { TitleEditInput } from '@/components/editable-title'
import { TaskRowMenu } from '@/components/task-row-menu'
import { Toaster, resetToasts } from '@/components/ui/toaster'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships neither of these; Radix positions the menu with floating-ui, which observes the
  // trigger's size, and the shell's breakpoint effect reads matchMedia. Same stubs as
  // `tools-menu.test.tsx`.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  )
})

afterEach(() => {
  cleanup()
  resetToasts()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1',
  title: 'Bump zod to v4',
  workflow: 'quick-task',
  task: 'Bump zod to v4',
  status: 'done',
  createdAt: '2026-08-24T12:00:00.000Z',
  finishedAt: '2026-08-24T13:00:00.000Z',
  seenAt: '2026-08-24T13:05:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...over,
})

/** Where the router ended up — the delete-navigates case is about this and nothing else. */
function Here() {
  return <span data-slot="here">{useLocation().pathname}</span>
}

/** A stand-in for the sidebar row: the same shape (a link plus a title that flips into an input)
 *  without the quick-list's buckets, so a failure here is about the MENU. */
function renderMenu(
  record: RunRecord = run(),
  { scope = null, active = false, route = '/' }: { scope?: string | null; active?: boolean; route?: string } = {}
) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <TaskRowMenu run={record} scope={scope} active={active}>
          {(editor) => (
            <div data-slot="task-row" data-run-id={record.id}>
              {editor.editing ? (
                <TitleEditInput editor={editor} />
              ) : (
                <a href={`/tasks/${record.id}`}>{record.title}</a>
              )}
            </div>
          )}
        </TaskRowMenu>
        <Routes>
          <Route path="*" element={<Here />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const theRow = () => document.querySelector('[data-slot="task-row"]') as HTMLElement

/** Queried by slot rather than by role: while the menu is open Radix marks the rest of the
 *  document `aria-hidden`, so a role query would not see the row it is anchored to. */
const rowLink = () => theRow().querySelector('a')
const renameInput = async (): Promise<HTMLInputElement> =>
  await waitFor(() => {
    const input = document.querySelector('[data-slot="title-input"]')
    if (!input) throw new Error('the row did not flip into an input')
    return input as HTMLInputElement
  })

/** Right-click the row and wait for the menu Radix portals into the document. */
async function openMenu(): Promise<HTMLElement> {
  fireEvent.contextMenu(theRow())
  return await waitFor(() => {
    const menu = document.querySelector('[data-slot="task-row-menu"]')
    if (!menu) throw new Error('the menu did not open')
    return menu as HTMLElement
  })
}

const itemsIn = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll('[data-slot="context-menu-item"]')].map((el) => (el.textContent ?? '').trim())

const pick = (menu: HTMLElement, action: string): void => {
  const item = menu.querySelector(`[data-action="${action}"]`)
  if (!item) throw new Error(`no "${action}" item in the menu — it offers ${itemsIn(menu).join(', ')}`)
  fireEvent.click(item)
}

/** The (path, method, body) of the last request the row's action made. */
function lastRequest(): { path: string; method: string; body: unknown } {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) throw new Error('nothing was requested')
  const [path, init = {}] = call as [string, RequestInit]
  return {
    path,
    method: String(init.method),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  }
}

describe('TaskRowMenu', () => {
  it('opens on right-click with the actions the run can take', async () => {
    renderMenu()
    expect(itemsIn(await openMenu())).toEqual(['Rename', 'Mark unread', 'Archive', 'Delete'])
  })

  it('offers Unarchive — and no read action — for an archived run', async () => {
    renderMenu(run({ archived: true }))
    expect(itemsIn(await openMenu())).toEqual(['Rename', 'Unarchive', 'Delete'])
  })

  it('offers Cancel instead of Delete while the engine still owns the run', async () => {
    renderMenu(run({ status: 'running', finishedAt: undefined, seenAt: undefined }))
    expect(itemsIn(await openMenu())).toEqual(['Rename', 'Cancel'])
  })

  it('leaves the row itself a link — right-click is the only gesture it takes over', async () => {
    renderMenu()
    expect(screen.getByRole('link', { name: 'Bump zod to v4' }).getAttribute('href')).toBe('/tasks/r1')
    await openMenu()
    expect(rowLink()?.getAttribute('href')).toBe('/tasks/r1')
  })

  it('opens from the keyboard too — the context-menu key fires on the focused link', async () => {
    renderMenu()
    // Shift+F10 and the Menu key dispatch a `contextmenu` event at the FOCUSED element. The row's
    // link is focusable and the event bubbles to the trigger, so the menu has a keyboard path
    // without the row growing a kebab it has no width for.
    const link = screen.getByRole('link', { name: 'Bump zod to v4' })
    link.focus()
    fireEvent.contextMenu(link)
    await waitFor(() => expect(document.querySelector('[data-slot="task-row-menu"]')).not.toBeNull())
  })

  it('archives through the archive endpoint', async () => {
    renderMenu()
    pick(await openMenu(), 'archive')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastRequest()).toMatchObject({ path: '/api/v1/runs/r1/archive', method: 'POST', body: { archived: true } })
  })

  it('unarchives through the same endpoint, the other way round', async () => {
    renderMenu(run({ archived: true }))
    pick(await openMenu(), 'unarchive')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastRequest()).toMatchObject({ path: '/api/v1/runs/r1/archive', body: { archived: false } })
  })

  it('marks a read run unread', async () => {
    renderMenu()
    pick(await openMenu(), 'mark-unread')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastRequest()).toMatchObject({ path: '/api/v1/runs/r1/unread', method: 'POST' })
  })

  it('marks an unread run read', async () => {
    renderMenu(run({ seenAt: undefined }))
    pick(await openMenu(), 'mark-read')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastRequest()).toMatchObject({ path: '/api/v1/runs/r1/read', method: 'POST' })
  })

  // The whole reason `scope` is threaded through the sidebar: a row painted by ANOTHER project's
  // group must act on that project. `queryScope()` would answer with the mounted one, and a
  // colliding run id would then archive — or delete — the wrong task in the wrong repository.
  it('addresses the row’s OWN project, not the mounted scope', async () => {
    renderMenu(run(), { scope: 'proj-b' })
    pick(await openMenu(), 'archive')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(lastRequest().path).toBe('/api/v1/p/proj-b/runs/r1/archive')
  })

  describe('rename', () => {
    it('flips the row into an input and PATCHes what was typed', async () => {
      renderMenu()
      pick(await openMenu(), 'rename')

      const input = await renameInput()
      // Seeded with the STORED title, so committing an untouched draft is a no-op rather than a
      // rename to whatever the row had room to display.
      expect(input.value).toBe('Bump zod to v4')
      fireEvent.change(input, { target: { value: 'Bump zod to v4 everywhere' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(lastRequest()).toMatchObject({
        path: '/api/v1/runs/r1',
        method: 'PATCH',
        body: { title: 'Bump zod to v4 everywhere' },
      })
    })

    it('abandons on Escape without saying anything to the server', async () => {
      renderMenu()
      pick(await openMenu(), 'rename')

      const input = await renameInput()
      fireEvent.change(input, { target: { value: 'Never mind' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      await waitFor(() => expect(rowLink()?.textContent).toBe('Bump zod to v4'))
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('renames in the row’s own project too', async () => {
      renderMenu(run(), { scope: 'proj-b' })
      pick(await openMenu(), 'rename')

      const input = await renameInput()
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(lastRequest().path).toBe('/api/v1/p/proj-b/runs/r1')
    })

    it('does not re-enter the rename when a LATER menu is merely dismissed', async () => {
      // The "a rename was asked for" flag is consumed by the close that starts the edit. If it
      // ever leaked, the next menu the user dismissed would silently put the row into edit mode.
      renderMenu()
      pick(await openMenu(), 'rename')
      const input = await renameInput()
      fireEvent.keyDown(input, { key: 'Escape' })
      await waitFor(() => expect(rowLink()).not.toBeNull())

      fireEvent.keyDown(await openMenu(), { key: 'Escape' })
      await waitFor(() => expect(document.querySelector('[data-slot="task-row-menu"]')).toBeNull())
      expect(document.querySelector('[data-slot="title-input"]')).toBeNull()
    })
  })

  describe('the destructive pair', () => {
    it('asks before deleting, and names the task it is about to remove', async () => {
      renderMenu()
      pick(await openMenu(), 'delete')

      const dialog = await screen.findByRole('alertdialog')
      expect(dialog.textContent).toContain('Delete this task?')
      expect(dialog.textContent).toContain('Bump zod to v4')
      // Nothing has been asked of the server yet — the question is the whole point.
      expect(fetchMock).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(lastRequest()).toMatchObject({ path: '/api/v1/runs/r1', method: 'DELETE' })
    })

    it('keeps the task when the question is declined', async () => {
      renderMenu()
      pick(await openMenu(), 'delete')

      fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('asks before cancelling too', async () => {
      renderMenu(run({ status: 'running', finishedAt: undefined, seenAt: undefined }))
      pick(await openMenu(), 'cancel')

      const dialog = await screen.findByRole('alertdialog')
      expect(dialog.textContent).toContain('Cancel this task?')

      fireEvent.click(screen.getByRole('button', { name: 'Cancel the run' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(lastRequest()).toMatchObject({ path: '/api/v1/runs/r1/cancel', method: 'POST' })
    })

    it('leaves the page alone when the deleted row is not the one being read', async () => {
      renderMenu(run(), { route: '/tasks/other', active: false })
      pick(await openMenu(), 'delete')
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(document.querySelector('[data-slot="here"]')?.textContent).toBe('/tasks/other')
    })

    it('navigates home when the deleted row IS the one being read', async () => {
      renderMenu(run(), { route: '/tasks/r1', active: true })
      pick(await openMenu(), 'delete')
      fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(document.querySelector('[data-slot="here"]')?.textContent).toBe('/'))
    })
  })

  it('reports a refusal in the server’s own words', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'run is still active' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    )
    renderMenu()
    pick(await openMenu(), 'archive')

    const toastNode = await waitFor(() => {
      const node = document.querySelector('[data-slot="toast"]')
      if (!node) throw new Error('no toast')
      return node as HTMLElement
    })
    expect(toastNode.textContent).toContain('run is still active')
    expect(toastNode.dataset.tone).toBe('danger')
  })
})
