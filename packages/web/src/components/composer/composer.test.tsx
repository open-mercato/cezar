import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { Skill } from '@open-mercato/cezar-api-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'

import { MAX_IMAGE_BYTES } from './composer-images'
import { Composer, type ComposerProps } from './composer'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // cmdk sizes its list with a ResizeObserver; jsdom has none and never resizes anything.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
})

const SKILLS: Skill[] = [
  { name: 'global-deploy', description: 'Deploy from anywhere', body: '', path: '/g/global-deploy.md', source: 'global' },
  { name: 'om-fix', description: 'Fix an issue', body: '', path: '/p/om-fix.md', source: 'ai' },
  { name: 'om-review', body: '', path: '/p/om-review.md', source: 'cezar' },
]

/** The composer fetches `/api/v1/skills` (only once `/` has been typed) and `/api/v1/ui-state`
 *  (#519: the autocomplete's usage order + bump). `uiState: null` answers the GET with a 404
 *  (the "ui-state unavailable" case); PUT bodies are recorded in `uiStatePuts`. */
function stubSkillsFetch(uiState: Record<string, unknown> | null = {}) {
  const uiStatePuts: unknown[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/v1/ui-state')) {
      if ((init?.method ?? 'GET') === 'PUT') uiStatePuts.push(JSON.parse(String(init?.body)))
      const status = uiState === null ? 404 : 200
      const body = uiState === null ? JSON.stringify({ error: 'nope' }) : JSON.stringify(uiState)
      return Promise.resolve(
        new Response(body, { status, headers: { 'content-type': 'application/json' } }),
      )
    }
    const body = url.includes('/api/v1/skills') ? JSON.stringify(SKILLS) : '[]'
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, uiStatePuts }
}

function renderComposer(
  props: Partial<ComposerProps> = {},
  uiState: Record<string, unknown> | null = {},
) {
  const { fetchMock, uiStatePuts } = stubSkillsFetch(uiState)
  const onSubmit = vi.fn(() => Promise.resolve({}))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Composer onSubmit={onSubmit} {...props} />
      <Toaster />
    </QueryClientProvider>,
  )
  return {
    onSubmit,
    fetchMock,
    uiStatePuts,
    textarea: screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement,
  }
}

const type = (textarea: HTMLTextAreaElement, value: string) =>
  fireEvent.change(textarea, { target: { value } })

const pngFile = (name = 'shot.png', bytes: number[] = [1, 2, 3]) =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' })

const paste = (textarea: HTMLTextAreaElement, files: File[]) =>
  fireEvent.paste(textarea, {
    clipboardData: { items: files.map((file) => ({ type: file.type, getAsFile: () => file })) },
  })

describe('submit shortcuts', () => {
  it('Enter sends the trimmed text and clears optimistically', async () => {
    const { onSubmit, textarea } = renderComposer()
    type(textarea, '  hello agent  ')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('hello agent', [])
    expect(textarea.value).toBe('')
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it('Shift+Enter does NOT send — it is the newline', () => {
    const { onSubmit, textarea } = renderComposer()
    type(textarea, 'line one')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('line one')
  })

  it('⌘↵ and Ctrl+↵ both send (the cross-platform chord)', async () => {
    const { onSubmit, textarea } = renderComposer()
    type(textarea, 'one')
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    // One send at a time — wait the first out before the second chord.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    type(textarea, 'two')
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(onSubmit).toHaveBeenNthCalledWith(1, 'one', [])
    expect(onSubmit).toHaveBeenNthCalledWith(2, 'two', [])
  })

  it('empty text sends nothing, and the send button is disabled', () => {
    const { onSubmit, textarea } = renderComposer()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the send button sends too', () => {
    const { onSubmit, textarea } = renderComposer()
    type(textarea, 'via button')
    fireEvent.click(screen.getByLabelText('Send'))
    expect(onSubmit).toHaveBeenCalledWith('via button', [])
  })
})

describe('failure restores the draft (nothing the user typed is ever lost)', () => {
  it('rejection → danger toast with the server words + the text back in the box', async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error('session closed — the agent is no longer listening')))
    const { textarea } = renderComposer({ onSubmit })
    type(textarea, 'my careful reply')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('') // optimistic
    await waitFor(() => expect(textarea.value).toBe('my careful reply'))
    expect(screen.getByText('session closed — the agent is no longer listening')).toBeTruthy()
  })

  it('text typed while the failed send was in flight is kept below the restored draft', async () => {
    let reject!: (reason: Error) => void
    const onSubmit = vi.fn(() => new Promise((_, rej) => (reject = rej)))
    const { textarea } = renderComposer({ onSubmit })
    type(textarea, 'first message')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    type(textarea, 'meanwhile')
    reject(new Error('boom'))
    await waitFor(() => expect(textarea.value).toBe('first message\nmeanwhile'))
  })
})

describe('images — attach, paste, thumbnails, caps (legacy parity)', () => {
  it('pasted screenshots become removable thumbnails and ride the submit', async () => {
    const { onSubmit, textarea } = renderComposer()
    paste(textarea, [pngFile('shot.png', [9, 9])])
    const thumb = await screen.findByLabelText('Remove shot.png')
    expect(thumb).toBeTruthy()

    type(textarea, 'see screenshot')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('see screenshot', [
      { mediaType: 'image/png', data: btoa(String.fromCharCode(9, 9)) },
    ])
    // Sent images leave the tray with the optimistic clear.
    await waitFor(() => expect(screen.queryByLabelText('Remove shot.png')).toBeNull())
  })

  it('a single paste adds exactly ONE thumbnail under StrictMode (#double-paste regression)', async () => {
    // StrictMode double-invokes state updaters in dev; the earlier addFiles ran its async encode
    // inside the setImages updater, so one paste appended the image twice. Render under
    // StrictMode to lock the fix in.
    const onSubmit = vi.fn(() => Promise.resolve({}))
    stubSkillsFetch()
    render(
      <React.StrictMode>
        <QueryClientProvider client={createQueryClient()}>
          <Composer onSubmit={onSubmit} />
          <Toaster />
        </QueryClientProvider>
      </React.StrictMode>,
    )
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    paste(textarea, [pngFile('once.png')])
    await screen.findByLabelText('Remove once.png')
    expect(screen.getAllByLabelText(/^Remove /)).toHaveLength(1)
  })

  it('an image alone (no text) is sendable — the server accepts either', async () => {
    const { onSubmit, textarea } = renderComposer()
    paste(textarea, [pngFile()])
    await screen.findByLabelText('Remove shot.png')
    fireEvent.click(screen.getByLabelText('Send'))
    expect(onSubmit).toHaveBeenCalledWith('', [expect.objectContaining({ mediaType: 'image/png' })])
  })

  it('clicking a thumbnail removes exactly that image', async () => {
    const { textarea } = renderComposer()
    paste(textarea, [pngFile('a.png'), pngFile('b.png')])
    await screen.findByLabelText('Remove b.png')
    fireEvent.click(screen.getByLabelText('Remove a.png'))
    expect(screen.queryByLabelText('Remove a.png')).toBeNull()
    expect(screen.getByLabelText('Remove b.png')).toBeTruthy()
  })

  it('a 5th image is refused with a toast naming it', async () => {
    const { textarea } = renderComposer()
    paste(textarea, ['a', 'b', 'c', 'd'].map((n) => pngFile(`${n}.png`)))
    await screen.findByLabelText('Remove d.png')
    paste(textarea, [pngFile('e.png')])
    expect(await screen.findByText('e.png skipped — max 4 images per message')).toBeTruthy()
    expect(screen.queryByLabelText('Remove e.png')).toBeNull()
  })

  it('an oversized image is refused with the 5 MB toast', async () => {
    const { textarea } = renderComposer()
    const big = pngFile('huge.png')
    Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 })
    paste(textarea, [big])
    expect(await screen.findByText('huge.png is too large (max 5 MB)')).toBeTruthy()
    expect(screen.queryByLabelText('Remove huge.png')).toBeNull()
  })
})

describe('/ skills autocomplete (#380)', () => {
  it('opens at a word boundary, fetches skills lazily, lists project skills first and bold', async () => {
    const { fetchMock, textarea } = renderComposer()
    // No `/` yet — no skills fetch.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/v1/skills'))).toHaveLength(0)

    type(textarea, 'please /')
    const items = await screen.findAllByText(/om-fix|om-review|global-deploy/)
    expect(items.length).toBeGreaterThanOrEqual(3)
    const rendered = [...document.querySelectorAll('[data-slot="composer-menu-item"]')]
    expect(rendered.map((el) => el.getAttribute('data-emphasized'))).toEqual(['true', 'true', null])
    expect(rendered[0]!.textContent).toContain('om-fix')
    expect(rendered[2]!.textContent).toContain('global-deploy')
  })

  it('the menu is clamped to the popper available height (mobile keyboard, #mobile-kb)', async () => {
    const { textarea } = renderComposer()
    type(textarea, '/')
    await screen.findByText('om-fix')
    const menu = document.querySelector('[data-slot="composer-menu"]')!
    // The clamp keeps the list inside the visual viewport once PopoverContent's
    // keyboard-aware collisionPadding has shrunk the popper's available space.
    expect(menu.className).toContain('--radix-popover-content-available-height')
  })

  it('mid-word slashes (URLs) never open the menu', () => {
    const { textarea } = renderComposer()
    type(textarea, 'see https://example.com/x')
    expect(document.querySelector('[data-slot="composer-menu"]')).toBeNull()
  })

  it('typing narrows the list without reordering project-first', async () => {
    const { textarea } = renderComposer()
    type(textarea, '/deploy')
    await screen.findByText('global-deploy')
    const rendered = [...document.querySelectorAll('[data-slot="composer-menu-item"]')]
    expect(rendered).toHaveLength(1)
  })

  it('Enter inserts the selection at the caret and closes the menu', async () => {
    const { onSubmit, textarea } = renderComposer()
    type(textarea, 'run /omf')
    await screen.findByText('om-fix')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('run /om-fix ')
    expect(textarea.selectionStart).toBe('run /om-fix '.length)
    expect(document.querySelector('[data-slot="composer-menu"]')).toBeNull()
    // The Enter was a pick, not a send.
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('arrow keys move the selection; Enter takes the highlighted one', async () => {
    const { textarea } = renderComposer()
    type(textarea, '/om')
    await screen.findByText('om-fix')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('/om-review ')
  })

  it('clicking an item inserts it too', async () => {
    const { textarea } = renderComposer()
    type(textarea, '/om')
    const item = await screen.findByText('om-review')
    fireEvent.click(item.closest('[data-slot="composer-menu-item"]') as HTMLElement)
    expect(textarea.value).toBe('/om-review ')
  })

  it('Escape closes the menu and keeps the text; Enter then sends the raw text', async () => {
    const { onSubmit, textarea } = renderComposer()
    type(textarea, '/om')
    await screen.findByText('om-fix')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-slot="composer-menu"]')).toBeNull())
    expect(textarea.value).toBe('/om')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('/om', [])
  })

  it('a completed token (trailing space) closes the menu', async () => {
    const { textarea } = renderComposer()
    type(textarea, '/om')
    await screen.findByText('om-fix')
    type(textarea, '/om-fix done')
    await waitFor(() => expect(document.querySelector('[data-slot="composer-menu"]')).toBeNull())
  })

  it('autocompleteSkills={false} keeps / as plain text', () => {
    const { textarea } = renderComposer({ autocompleteSkills: false })
    type(textarea, '/om')
    expect(document.querySelector('[data-slot="composer-menu"]')).toBeNull()
  })
})

describe('/ autocomplete usage order and pick bump (#519)', () => {
  const menuNames = () =>
    [...document.querySelectorAll('[data-slot="composer-menu-item"]')].map(
      (el) => el.querySelector('span')?.textContent,
    )

  it('orders the list most-used first, across localities', async () => {
    const { textarea } = renderComposer({}, { skillUsage: { 'global-deploy': 4, 'om-review': 1 } })
    type(textarea, '/')
    await screen.findByText('om-fix')
    // Once ui-state resolves, the used skills lead regardless of locality; unused project
    // skills follow, per the #519 tier order.
    await waitFor(() => expect(menuNames()).toEqual(['global-deploy', 'om-review', 'om-fix']))
  })

  it('picking a skill bumps its skillUsage count (the whole map, shallow-merge safe)', async () => {
    const { textarea, uiStatePuts } = renderComposer({}, { skillUsage: { 'global-deploy': 4 } })
    type(textarea, '/')
    await screen.findByText('om-fix')
    // The visible reorder proves the ui-state query resolved — the bump guard is now open.
    await waitFor(() => expect(menuNames()[0]).toBe('global-deploy'))
    type(textarea, '/omf')
    await waitFor(() => expect(menuNames()).toEqual(['om-fix']))
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(uiStatePuts).toHaveLength(1))
    // The WHOLE updated map, never one entry — the PUT merge is shallow (#408).
    expect(uiStatePuts[0]).toEqual({ skillUsage: { 'global-deploy': 4, 'om-fix': 1 } })
  })

  it('ui-state unavailable → the pick still completes but never PUTs a wiped map', async () => {
    const { textarea, uiStatePuts } = renderComposer({}, null)
    type(textarea, 'run /omf')
    await screen.findByText('om-fix')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('run /om-fix ')
    expect(uiStatePuts).toHaveLength(0)
  })

  it('an @ mention pick never touches skillUsage', async () => {
    const { textarea, uiStatePuts } = renderComposer(
      { getMentionCandidates: () => ['src/app.ts'] },
      { skillUsage: {} },
    )
    type(textarea, 'see @app')
    await screen.findByText('src/app.ts')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('see @src/app.ts ')
    expect(uiStatePuts).toHaveLength(0)
  })
})

describe('@ file mentions — the provider seam (R5 upgrades the source, not the composer)', () => {
  it('lists and inserts the provider paths, fuzzy-filtered', async () => {
    const { textarea } = renderComposer({
      getMentionCandidates: () => ['src/server/server.ts', 'README.md'],
    })
    type(textarea, 'fix @readme')
    await screen.findByText('README.md')
    expect(screen.queryByText('src/server/server.ts')).toBeNull()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('fix @README.md ')
  })

  it('a provider with nothing yet says so honestly instead of faking results', async () => {
    const { textarea } = renderComposer({ getMentionCandidates: () => [] })
    type(textarea, '@x')
    expect(
      await screen.findByText(/No files seen in this session yet/),
    ).toBeTruthy()
  })

  it('without a provider, @ stays plain text — no empty menu', () => {
    const { textarea } = renderComposer()
    type(textarea, '@x')
    expect(document.querySelector('[data-slot="composer-menu"]')).toBeNull()
  })
})

describe('quick replies (legacy Alt+A / Alt+C)', () => {
  it('Alt+A sends "Yes, approved." and Alt+C sends "Continue." without touching the draft', async () => {
    let finishFirstDelivery = () => {}
    const firstDelivery = new Promise<void>((resolve) => {
      finishFirstDelivery = resolve
    })
    const onSubmit = vi
      .fn()
      .mockImplementationOnce(() => firstDelivery)
      .mockResolvedValue(undefined)
    const { textarea } = renderComposer({ quickReplies: true, onSubmit })
    type(textarea, 'draft in progress')
    fireEvent.keyDown(window, { code: 'KeyA', altKey: true })
    expect(onSubmit).toHaveBeenCalledWith('Yes, approved.', [])
    expect(textarea.value).toBe('draft in progress')
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true)

    // One send at a time: settle the first delivery, then wait for send to re-enable before
    // exercising the second shortcut. A resolved-by-default mock can make this wait pass before
    // React ever commits the busy state, racing the second keydown against a stale closure.
    finishFirstDelivery()
    await waitFor(() =>
      expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.keyDown(window, { code: 'KeyC', altKey: true })
    expect(onSubmit).toHaveBeenCalledWith('Continue.', [])
  })

  /** ⌥ is a CHARACTER modifier on macOS: ⌥C types `ć` on a Polish layout (`ç` on a US one) and
   *  ⌥A types `ą`/`å` — each arriving with the very `event.code` this shortcut matches on. Typed
   *  into the composer, that fired "Continue." at the agent and `preventDefault` swallowed the
   *  letter. Someone with a caret in the textarea is writing, not reaching for an accelerator. */
  it('leaves an Alt-composed character alone while the caret is in an editable', () => {
    const { textarea, onSubmit } = renderComposer({ quickReplies: true })
    type(textarea, 'popraw to')
    const delivered = fireEvent.keyDown(textarea, { code: 'KeyC', key: 'ć', altKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    // Not prevented either — the browser still gets to insert the character.
    expect(delivered).toBe(true)
    fireEvent.keyDown(textarea, { code: 'KeyA', key: 'ą', altKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does nothing without the flag, with other modifiers, or while disabled', () => {
    const { onSubmit } = renderComposer({ quickReplies: true, disabled: true })
    fireEvent.keyDown(window, { code: 'KeyA', altKey: true })
    fireEvent.keyDown(window, { code: 'KeyA', altKey: true, ctrlKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    cleanup()

    const second = renderComposer() // no quickReplies flag
    fireEvent.keyDown(window, { code: 'KeyA', altKey: true })
    expect(second.onSubmit).not.toHaveBeenCalled()
  })
})

describe('disabled state', () => {
  it('disables everything and explains itself in the placeholder', () => {
    renderComposer({
      disabled: true,
      disabledReason: 'Session closed — no session to resume.',
    })
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('Session closed — no session to resume.')
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Attach images') as HTMLButtonElement).disabled).toBe(true)
  })

  /** `allowEmptySubmit` is the thread's Continue: an empty draft is a meaningful action there
   *  (reopen the session on the engine's own "Continue."), so the send button stays live. */
  it('allowEmptySubmit lets an empty draft submit — and disabled still wins over it', () => {
    const { onSubmit } = renderComposer({ allowEmptySubmit: true })
    const send = screen.getByLabelText('Send') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    expect(onSubmit).toHaveBeenCalledWith('', [])
    cleanup()

    renderComposer({ allowEmptySubmit: true, disabled: true })
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the mic is hidden entirely when the Web Speech API is absent — no fake button', () => {
    renderComposer()
    expect(screen.queryByText('Dictation')).toBeNull()
  })
})

describe('host seams (R4: the /new hero)', () => {
  it('controlled value: the parent owns the text, and every edit flows through onValueChange', async () => {
    const changes: string[] = []
    stubSkillsFetch()
    const onSubmit = vi.fn(() => Promise.resolve({}))
    const { rerender } = render(
      <QueryClientProvider client={createQueryClient()}>
        <Composer onSubmit={onSubmit} value="from the draft" onValueChange={(t) => changes.push(t)} />
        <Toaster />
      </QueryClientProvider>,
    )
    const textarea = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
    expect(textarea.value).toBe('from the draft')

    type(textarea, 'edited')
    expect(changes).toEqual(['edited'])
    // Still parent-owned: without a rerender the visible value stays the prop's.
    rerender(
      <QueryClientProvider client={createQueryClient()}>
        <Composer onSubmit={onSubmit} value="edited" onValueChange={(t) => changes.push(t)} />
        <Toaster />
      </QueryClientProvider>,
    )
    // The optimistic clear on send reaches the parent too.
    fireEvent.keyDown(screen.getByLabelText('Reply to the agent'), { key: 'Enter' })
    expect(changes).toEqual(['edited', ''])
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('edited', []))
  })

  it('a rejected send restores the draft through onValueChange (controlled mode loses nothing)', async () => {
    const changes: string[] = []
    stubSkillsFetch()
    const onSubmit = vi.fn(() => Promise.reject(new Error('server said no')))
    // A REAL controlled parent: state wired both ways, like the /new draft store.
    function Host() {
      const [text, setText] = React.useState('precious words')
      return (
        <Composer
          onSubmit={onSubmit}
          value={text}
          onValueChange={(next) => {
            changes.push(next)
            setText(next)
          }}
        />
      )
    }
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Host />
        <Toaster />
      </QueryClientProvider>,
    )
    fireEvent.keyDown(screen.getByLabelText('Reply to the agent'), { key: 'Enter' })
    // Optimistic clear, then the restore once the server rejected.
    await waitFor(() => expect(changes).toEqual(['', 'precious words']))
    expect((screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement).value).toBe('precious words')
  })

  it('renders footerStart and footerEnd in the footer bar, and honors sendAriaLabel', () => {
    renderComposer({
      footerStart: <button type="button">a pill</button>,
      footerEnd: <kbd>⌘↵</kbd>,
      sendAriaLabel: 'Start task',
    })
    expect(document.querySelector('[data-slot="composer-footer-start"]')?.textContent).toBe('a pill')
    expect(document.querySelector('[data-slot="composer-footer-end"]')?.textContent).toBe('⌘↵')
    expect(screen.getByLabelText('Start task')).toBeTruthy()
    expect(screen.queryByLabelText('Send')).toBeNull()
  })

  it('autoFocus puts the caret in the textarea on mount (⌘N lands ready to type)', () => {
    const { textarea } = renderComposer({ autoFocus: true })
    expect(document.activeElement).toBe(textarea)
  })

  it('without autoFocus the composer never steals focus', () => {
    const { textarea } = renderComposer()
    expect(document.activeElement).not.toBe(textarea)
  })
})
