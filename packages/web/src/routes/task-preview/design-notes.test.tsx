import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import type { ReactNode } from 'react'

import { DesignNotePopup, DesignNotesTray } from './design-note-popup'
import { advance, noteMessage, notesMessage, parseDraftNotes, resetDesignNotes, useDesignNotes, type DesignNote } from './design-notes'

/**
 * Design Mode notes (spec `.ai/specs/2026-10-09-design-mode.md` §7): one element, one prompt.
 *
 * Pinned here: where a note goes for each state of the session (live message or Continue), that a draft is written through
 * to the server (it must survive a reload), and how a sent note's status follows the run without
 * ever being stored.
 */

const api = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  continueRun: vi.fn(),
  putRunDraft: vi.fn(),
  getRun: vi.fn(),
}))
vi.mock('@/api/client', () => ({
  ...api,
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))
const { ApiError } = await import('@/api/client')

const stored = vi.hoisted(() => ({ text: undefined as string | undefined, ready: true }))
vi.mock('@/api/queries', () => ({
  // The delivery seam's two reads, over the same stubbed server.
  useSendMessage: (id: string) => ({ mutateAsync: (message: unknown) => api.sendMessage(id, message) }),
  runQueryOptions: (id: string) => ({ queryKey: ['run', id], queryFn: () => api.getRun(id) }),
  useRunDrafts: () => ({
    isSuccess: stored.ready,
    data: stored.ready ? { surfaces: stored.text === undefined ? {} : { 'design-picks': { text: stored.text } } } : undefined,
  }),
}))
const toast = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast }))

const PICK = {
  url: 'http://localhost:5173/settings',
  selector: 'main > button.save',
  tag: 'button',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: {},
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 800, height: 600 },
  components: [],
  source: '',
  mark: 'abc-1',
}
const run = (over: Partial<ApiRun> = {}): ApiRun =>
  ({ id: 'run-1', status: 'running', steps: [{ id: 'task', sessionId: 'sess-1' }], ...over }) as ApiRun
let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  for (const mock of Object.values(api)) mock.mockReset()
  api.sendMessage.mockResolvedValue({ queued: true })
  api.continueRun.mockResolvedValue({ ok: true })
  api.putRunDraft.mockResolvedValue({})
  api.getRun.mockResolvedValue(run({ status: 'done' }))
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  toast.mockReset()
  stored.text = undefined
  stored.ready = true
  resetDesignNotes()
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

/** The hook with a run the test can change, plus one draft with text in it. */
function notesWithDraft(initial: ApiRun, text = 'make it bigger') {
  const hook = renderHook(({ current }) => useDesignNotes(current), { initialProps: { current: initial }, wrapper })
  act(() => {
    expect(hook.result.current.addDraft(PICK)).toBe(true)
    hook.result.current.setText('abc-1', text)
  })
  return hook
}

describe('a draft', () => {
  it('frames its element plainly and says how to find it again', () => {
    const { result } = notesWithDraft(run())
    expect(result.current.marks).toEqual([
      { key: 'abc-1', selector: 'main > button.save', path: '/settings', label: 'button.save', draft: true },
    ])
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'draft', text: 'make it bigger' })
  })

  it('is written through to the run\'s draft store — typing is one write, not one per key', async () => {
    const { result } = notesWithDraft(run())
    act(() => result.current.setText('abc-1', 'make it bigger and blue'))
    await act(() => vi.advanceTimersByTimeAsync(600))
    const [id, surface, body] = api.putRunDraft.mock.calls.at(-1) as [string, string, { text: string }]
    expect([id, surface]).toEqual(['run-1', 'design-picks'])
    expect(parseDraftNotes(body.text)).toEqual([{ key: 'abc-1', pick: PICK, text: 'make it bigger and blue' }])
    expect(api.putRunDraft.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('comes back after a reload, text and element', () => {
    stored.text = JSON.stringify([{ pick: PICK, text: 'half-written' }])
    const { result } = renderHook(() => useDesignNotes(run()), { wrapper })
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'draft', text: 'half-written' })
  })

  it('is not accepted before the stored drafts arrived — an early pick would overwrite them', () => {
    stored.ready = false
    const { result } = renderHook(() => useDesignNotes(run()), { wrapper })
    let kept = true
    act(() => {
      kept = result.current.addDraft(PICK)
    })
    expect(kept).toBe(false)
    expect(api.putRunDraft).not.toHaveBeenCalled()
  })

  it('remembers being added across a reload', async () => {
    const { result } = notesWithDraft(run())
    act(() => result.current.markAdded('abc-1'))
    expect(result.current.note('abc-1')?.added).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(10))
    const [, , body] = api.putRunDraft.mock.calls.at(-1) as [string, string, { text: string }]
    expect(parseDraftNotes(body.text)[0]).toMatchObject({ key: 'abc-1', added: true })
  })

  it('is deselected and forgotten when discarded', async () => {
    const { result } = notesWithDraft(run())
    act(() => result.current.discard('abc-1'))
    expect(result.current.marks).toEqual([])
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect((api.putRunDraft.mock.calls.at(-1) as [string, string, { text: string }])[2].text).toBe('')
  })
})

describe('sending a note', () => {
  it.each(['running', 'waiting', 'queued'] as const)('goes into a %s session as a live message: numbered, the draft gone', async (status) => {
    const { result } = notesWithDraft(run({ status }))
    await act(() => result.current.sendAll())
    const [id, body] = api.sendMessage.mock.calls[0] as [string, { text: string }]
    expect(id).toBe('run-1')
    expect(body.text.startsWith('make it bigger\n\nElements selected in the app preview:')).toBe(true)
    expect(body.text).toContain('`main > button.save`')
    expect(api.continueRun).not.toHaveBeenCalled()
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'running', number: 1 })
    // A sent note keeps its frame, numbered, and is not looked for again after a reload.
    expect(result.current.marks).toEqual([{ key: 'abc-1', n: 1, label: 'button.save', draft: false }])
  })

  it.each(['done', 'failed', 'cancelled', 'review'] as const)('reopens a %s session with the note', async (status) => {
    const { result } = notesWithDraft(run({ status }))
    await act(() => result.current.sendAll())
    expect(api.continueRun).toHaveBeenCalledWith('run-1', { text: expect.stringContaining('make it bigger') })
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(result.current.note('abc-1')?.phase).toBe('running')
  })

  it('reopens when the session closed under the live send (a stale record answers 409)', async () => {
    api.sendMessage.mockRejectedValue(new ApiError(409, 'session closed'))
    const { result } = notesWithDraft(run({ status: 'waiting' }))
    await act(() => result.current.sendAll())
    expect(api.continueRun).toHaveBeenCalledTimes(1)
    expect(result.current.note('abc-1')?.phase).toBe('running')
  })

  it('keeps the draft exactly as it was when a fresh record agrees with the refused path', async () => {
    api.sendMessage.mockRejectedValue(new ApiError(409, 'provider disconnected'))
    api.getRun.mockResolvedValue(run({ status: 'running' }))
    const { result } = notesWithDraft(run({ status: 'running' }))
    await expect(act(() => result.current.sendAll())).rejects.toThrow(/provider disconnected/)
    expect(api.continueRun).not.toHaveBeenCalled()
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'draft', text: 'make it bigger' })
  })

  it('waits out a run still unwinding its settled turn instead of failing the note (telemetry 77117b95)', async () => {
    api.continueRun.mockRejectedValueOnce(new ApiError(409, 'run is still active'))
    api.sendMessage.mockRejectedValue(new ApiError(409, 'session closed'))
    const { result } = notesWithDraft(run({ status: 'done' }))
    await act(async () => {
      const sent = result.current.sendAll()
      await vi.advanceTimersByTimeAsync(300)
      await sent
    })
    expect(api.continueRun).toHaveBeenCalledTimes(2)
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'running', number: 1 })
  })

  it('does not retry anything but a 409', async () => {
    api.sendMessage.mockRejectedValue(new ApiError(500, 'boom'))
    const { result } = notesWithDraft(run({ status: 'running' }))
    await expect(act(() => result.current.sendAll())).rejects.toThrow(/boom/)
    expect(api.continueRun).not.toHaveBeenCalled()
  })

  it('sends every written draft as one message, numbered in the order picked; empty drafts stay', async () => {
    const { result } = notesWithDraft(run())
    act(() => {
      result.current.addDraft({ ...PICK, mark: 'abc-2', selector: 'main > p.price' })
      result.current.setText('abc-2', 'red')
      result.current.addDraft({ ...PICK, mark: 'abc-3', selector: 'main > h1' })
    })
    expect(result.current.ready).toBe(2)
    await act(() => result.current.sendAll())
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    const [, body] = api.sendMessage.mock.calls[0] as [string, { text: string }]
    expect(body.text).toMatch(/^## Note 1\n\nmake it bigger\n[\s\S]*## Note 2\n\nred\n/)
    expect(result.current.notes.map((note) => [note.key, note.phase, note.number])).toEqual([
      ['abc-3', 'draft', undefined],
      ['abc-1', 'running', 1],
      ['abc-2', 'running', 2],
    ])
    expect(result.current.ready).toBe(0)
  })

  it('freezes the batch while it is on its way, so no edit is lost to it', async () => {
    let land!: () => void
    api.sendMessage.mockReturnValue(new Promise<void>((resolve) => (land = resolve)))
    const { result } = notesWithDraft(run({ status: 'running' }))
    let sent!: Promise<void>
    act(() => {
      sent = result.current.sendAll()
    })
    expect(result.current.sending).toBe(true)
    act(() => {
      result.current.setText('abc-1', 'lost?')
      result.current.discard('abc-1')
    })
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'draft', text: 'make it bigger' })
    await act(async () => {
      land()
      await sent
    })
    expect(result.current.sending).toBe(false)
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'running', text: 'make it bigger' })
  })

  it('freezes only the batch: a draft picked mid-send stays editable', async () => {
    let land!: () => void
    api.sendMessage.mockReturnValue(new Promise<void>((resolve) => (land = resolve)))
    const { result } = notesWithDraft(run({ status: 'running' }))
    let sent!: Promise<void>
    act(() => {
      sent = result.current.sendAll()
    })
    act(() => {
      result.current.addDraft({ ...PICK, mark: 'abc-2', selector: 'main > p.price' })
      result.current.setText('abc-2', 'red')
    })
    expect(result.current.note('abc-1')?.sending).toBe(true)
    expect(result.current.note('abc-2')).toMatchObject({ text: 'red' })
    expect(result.current.note('abc-2')?.sending).toBeUndefined()
    await act(async () => {
      land()
      await sent
    })
    expect(result.current.note('abc-2')).toMatchObject({ phase: 'draft', text: 'red' })
  })

  it('unfreezes the batch when the send fails, leaving it editable', async () => {
    api.sendMessage.mockRejectedValue(new ApiError(500, 'boom'))
    const { result } = notesWithDraft(run({ status: 'running' }))
    await expect(act(() => result.current.sendAll())).rejects.toThrow(/boom/)
    expect(result.current.sending).toBe(false)
    expect(result.current.note('abc-1')?.sending).toBeUndefined()
    act(() => result.current.setText('abc-1', 'try again'))
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'draft', text: 'try again' })
  })

  it('numbers notes in the order they were sent', async () => {
    const { result } = notesWithDraft(run())
    await act(() => result.current.sendAll())
    act(() => {
      result.current.addDraft({ ...PICK, mark: 'abc-2', selector: 'main > p.price' })
      result.current.setText('abc-2', 'red')
    })
    await act(() => result.current.sendAll())
    expect(result.current.notes.map((note) => [note.key, note.number])).toEqual([
      ['abc-1', 1],
      ['abc-2', 2],
    ])
  })
})

describe('a sent note', () => {
  const delivered = async () => {
    const hook = notesWithDraft(run({ status: 'running' }))
    await act(() => hook.result.current.sendAll())
    return hook
  }

  it('follows the run: in progress → done', async () => {
    const hook = await delivered()
    const phase = () => hook.result.current.note('abc-1')?.phase
    hook.rerender({ current: run({ status: 'running' }) })
    expect(phase()).toBe('running')
    hook.rerender({ current: run({ status: 'waiting' }) })
    expect(phase()).toBe('done')
  })

  it('shows the agent\'s question instead of calling the note done', async () => {
    const hook = await delivered()
    hook.rerender({ current: run({ status: 'running' }) })
    hook.rerender({ current: { ...run({ status: 'waiting' }), askParked: true } as ApiRun })
    expect(hook.result.current.note('abc-1')?.phase).toBe('asking')
    // Answered: the agent is working on the note again, and then it is done.
    hook.rerender({ current: run({ status: 'running' }) })
    expect(hook.result.current.note('abc-1')?.phase).toBe('running')
    hook.rerender({ current: run({ status: 'done' }) })
    expect(hook.result.current.note('abc-1')?.phase).toBe('done')
  })
})

describe('advance', () => {
  const sent = (over: Record<string, unknown>) => ({ key: 'k', pick: PICK, text: 't', number: 1, sawRunning: false, phase: 'running', ...over }) as never
  const at = (status: ApiRun['status'], asking = false) => ({ status, asking })

  it('does not call a just-delivered note done before the run has been seen working', () => {
    // The send has returned; the run record this window holds still says `waiting`.
    const [note] = advance([sent({ deliveredAt: 1_000 })], at('waiting'), 1_500)
    expect(note!.phase).toBe('running')
  })

  it('finishes a note whose turn was too short to ever be seen, after a grace period', () => {
    const [note] = advance([sent({ deliveredAt: 1_000 })], at('waiting'), 30_000)
    expect(note!.phase).toBe('done')
  })

  it('keeps a whole batch delivered together in progress', () => {
    const next = advance(
      [sent({ key: 'a', deliveredAt: 40, sawRunning: true }), sent({ key: 'b', number: 2, deliveredAt: 40, sawRunning: true })],
      at('running'),
      50,
    )
    expect(next.map((note) => note.phase)).toEqual(['running', 'running'])
  })

  it('keeps only the note delivered last in progress', () => {
    const next = advance(
      [sent({ key: 'a', deliveredAt: 1, sawRunning: true }), sent({ key: 'b', number: 2, deliveredAt: 40 })],
      at('running'),
      50,
    )
    expect(next.map((note) => note.phase)).toEqual(['done', 'running'])
  })

  it('returns the same list when nothing moved, so nothing re-renders', () => {
    const list = [sent({ sawRunning: true, deliveredAt: 1 }), sent({ key: 'd', phase: 'done' })]
    expect(advance(list, at('running'), 5)).toBe(list)
  })
})

describe('parseDraftNotes', () => {
  it.each(['', 'nope', '{}', '[1, null, {"text": "x"}, {"pick": {"selector": "a", "tag": "a"}, "text": "no mark"}]'])(
    'keeps nothing of %j',
    (text) => {
      expect(parseDraftNotes(text)).toEqual([])
    },
  )
})

describe('notesMessage', () => {
  it('is the plain note for one, and numbered sections for several', () => {
    const one = { key: 'abc-1', pick: PICK, text: 'bigger' }
    expect(notesMessage([one])).toBe(noteMessage(one))
    expect(notesMessage([one, { ...one, key: 'abc-2', text: 'red' }]).match(/^## Note \d$/gm)).toEqual(['## Note 1', '## Note 2'])
  })

  it('refuses a batch over what one message can carry', () => {
    const long = { key: 'abc-1', pick: PICK, text: 'x'.repeat(20_000) }
    const batch = Array.from({ length: 6 }, (_, index) => ({ ...long, key: `abc-${index}` }))
    expect(() => notesMessage(batch)).toThrow(/send fewer at once/)
  })
})

describe('noteMessage', () => {
  it('is the user\'s words first, then the one element', () => {
    const message = noteMessage({ key: 'abc-1', pick: PICK, text: '  make it bigger  ' })
    expect(message.startsWith('make it bigger\n\n')).toBe(true)
    expect(message.match(/^- `/gm)).toHaveLength(1)
  })
})

describe('the note popup', () => {
  const actions = () => ({ setText: vi.fn(), markAdded: vi.fn(), discard: vi.fn() })
  const note = (over: Partial<DesignNote>): DesignNote => ({ key: 'abc-1', pick: PICK, text: 'make it bigger', phase: 'draft', ...over })

  it('names the element, takes the prompt, and adds it on Ctrl+Enter', () => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({})} notes={notes} onClose={onClose} />)
    expect(document.querySelector('[data-slot=design-note-element]')!.textContent).toBe('button.save')
    const field = screen.getByLabelText('Note for the agent')
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'make it bigger!' } })
    expect(notes.setText).toHaveBeenCalledWith('abc-1', 'make it bigger!')
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    // Added: the draft is kept, the window put away, nothing discarded.
    expect(notes.markAdded).toHaveBeenCalledWith('abc-1')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(notes.discard).not.toHaveBeenCalled()
  })

  it.each([
    ['✕', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Esc', () => fireEvent.keyDown(screen.getByLabelText('Note for the agent'), { key: 'Escape' })],
  ])('never throws an added note away on %s — only Delete removes it', (_label, close) => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({ added: true })} notes={notes} onClose={onClose} />)
    close()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(notes.discard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(notes.discard).toHaveBeenCalledWith('abc-1')
  })

  it('is read-only, with Delete off, only while its own batch is on its way', () => {
    const { rerender } = render(<DesignNotePopup note={note({ added: true, sending: true })} notes={actions()} onClose={vi.fn()} />)
    expect((screen.getByLabelText('Note for the agent') as HTMLTextAreaElement).readOnly).toBe(true)
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<DesignNotePopup note={note({ added: true })} notes={actions()} onClose={vi.fn()} />)
    expect((screen.getByLabelText('Note for the agent') as HTMLTextAreaElement).readOnly).toBe(false)
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('cannot add an empty note', () => {
    render(<DesignNotePopup note={note({ text: '   ' })} notes={actions()} onClose={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Add note' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says nothing about the session — no reopen wording, no hint', () => {
    render(<DesignNotePopup note={note({})} notes={actions()} onClose={vi.fn()} />)
    expect(screen.queryByText(/reopen/i)).toBeNull()
    expect(document.querySelector('[data-slot=design-note-hint]')).toBeNull()
  })

  it.each([
    ['✕', () => fireEvent.click(screen.getByRole('button', { name: 'Discard note' }))],
    ['Esc', () => fireEvent.keyDown(screen.getByLabelText('Note for the agent'), { key: 'Escape' })],
  ])('throws a draft away and deselects its element on %s', (_label, dismiss) => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({})} notes={notes} onClose={onClose} />)
    dismiss()
    expect(notes.discard).toHaveBeenCalledWith('abc-1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the tray sends the batch, and says why when it fails', async () => {
    const sendAll = vi.fn(async () => {})
    const { rerender } = render(<DesignNotesTray notes={{ ready: 2, sending: false, sendAll }} />)
    expect(document.querySelector('[data-slot=design-notes-tray]')!.textContent).toContain('2 notes')
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    await waitFor(() => expect(sendAll).toHaveBeenCalledTimes(1))
    sendAll.mockRejectedValueOnce(new Error('provider disconnected'))
    fireEvent.click(await screen.findByRole('button', { name: 'Send to agent' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('provider disconnected', { tone: 'danger' }))
    rerender(<DesignNotesTray notes={{ ready: 0, sending: false, sendAll }} />)
    expect(document.querySelector('[data-slot=design-notes-tray]')).toBeNull()
  })

  it.each([
    ['running', 'In progress'],
    ['asking', 'Agent is waiting for your answer'],
    ['done', 'Done'],
  ] as const)('is read-only once the note is with the agent (%s)', (phase, label) => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({ phase, number: 1 })} notes={notes} onClose={onClose} />)
    expect(document.querySelector('[data-slot=design-note-status]')!.textContent).toBe(label)
    expect(screen.queryByLabelText('Note for the agent')).toBeNull()
    expect(document.querySelector('[data-slot=design-note-text]')!.textContent).toBe('make it bigger')
    // Closing only hides it: nothing sent is thrown away.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(notes.discard).not.toHaveBeenCalled()
  })
})
