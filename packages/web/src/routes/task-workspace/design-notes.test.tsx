import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import { DesignNotePopup } from './design-note-popup'
import { advance, noteMessage, parseDraftNotes, resetDesignNotes, useDesignNotes, type DesignNote } from './design-notes'

/**
 * Design Mode notes (spec `.ai/specs/2026-10-09-design-mode.md` §7): one element, one prompt.
 *
 * Pinned here: where a note goes for each state of the session, that a draft is written through
 * to the server (it must survive a reload), and how a sent note's status follows the run without
 * ever being stored.
 */

const api = vi.hoisted(() => ({
  queueRunPrompt: vi.fn(),
  editQueuedRunPrompt: vi.fn(),
  removeQueuedRunPrompt: vi.fn(),
  sendMessage: vi.fn(),
  continueRun: vi.fn(),
  putRunDraft: vi.fn(),
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
const run = (over: Partial<ApiRun> = {}): ApiRun => ({ id: 'run-1', status: 'running', ...over }) as ApiRun

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  for (const mock of Object.values(api)) mock.mockReset()
  api.queueRunPrompt.mockResolvedValue({ queued: true, message: { id: 'q1', text: '', createdAt: '' } })
  api.editQueuedRunPrompt.mockResolvedValue({ message: { id: 'q1', text: '', createdAt: '' } })
  api.removeQueuedRunPrompt.mockResolvedValue({ removed: true })
  api.sendMessage.mockResolvedValue({ queued: true })
  api.continueRun.mockResolvedValue({ ok: true })
  api.putRunDraft.mockResolvedValue({})
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
  const hook = renderHook(({ current }) => useDesignNotes(current), { initialProps: { current: initial } })
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
    const { result } = renderHook(() => useDesignNotes(run()))
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'draft', text: 'half-written' })
  })

  it('is not accepted before the stored drafts arrived — an early pick would overwrite them', () => {
    stored.ready = false
    const { result } = renderHook(() => useDesignNotes(run()))
    let kept = true
    act(() => {
      kept = result.current.addDraft(PICK)
    })
    expect(kept).toBe(false)
    expect(api.putRunDraft).not.toHaveBeenCalled()
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
  it('waits its turn while the agent works: numbered, in the queue, the draft gone', async () => {
    const { result } = notesWithDraft(run({ status: 'running' }))
    await act(() => result.current.send('abc-1'))
    const [id, message] = api.queueRunPrompt.mock.calls[0] as [string, string]
    expect(id).toBe('run-1')
    expect(message.startsWith('make it bigger\n\nElements selected in the app preview:')).toBe(true)
    expect(message).toContain('`main > button.save`')
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'queued', number: 1, queueId: 'q1' })
    // A sent note keeps its frame, numbered, and is not looked for again after a reload.
    expect(result.current.marks).toEqual([{ key: 'abc-1', n: 1, label: 'button.save', draft: false }])
  })

  it('starts right away on an idle session', async () => {
    api.queueRunPrompt.mockResolvedValue({ delivered: true })
    const { result } = notesWithDraft(run({ status: 'waiting' }))
    await act(() => result.current.send('abc-1'))
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'running', number: 1 })
  })

  it.each(['done', 'failed', 'cancelled', 'review'] as const)('reopens a %s session with the note', async (status) => {
    const { result } = notesWithDraft(run({ status }))
    await act(() => result.current.send('abc-1'))
    expect(api.continueRun).toHaveBeenCalledWith('run-1', { text: expect.stringContaining('make it bigger') })
    expect(api.queueRunPrompt).not.toHaveBeenCalled()
    expect(result.current.note('abc-1')?.phase).toBe('running')
  })

  it('reopens when the session closed under the queue request', async () => {
    api.queueRunPrompt.mockRejectedValue(new ApiError(409, 'session closed'))
    const { result } = notesWithDraft(run({ status: 'waiting' }))
    await act(() => result.current.send('abc-1'))
    expect(api.continueRun).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft exactly as it was when the send is refused', async () => {
    api.queueRunPrompt.mockRejectedValue(new ApiError(409, 'prompt queue is full — 20 prompts at most'))
    const { result } = notesWithDraft(run({ status: 'running' }))
    await expect(act(() => result.current.send('abc-1'))).rejects.toThrow(/queue is full/)
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'draft', text: 'make it bigger' })
    expect(api.continueRun).not.toHaveBeenCalled()
  })

  it('numbers notes in the order they were sent', async () => {
    const { result } = notesWithDraft(run())
    await act(() => result.current.send('abc-1'))
    act(() => {
      result.current.addDraft({ ...PICK, mark: 'abc-2', selector: 'main > p.price' })
      result.current.setText('abc-2', 'red')
    })
    api.queueRunPrompt.mockResolvedValue({ queued: true, message: { id: 'q2', text: '', createdAt: '' } })
    await act(() => result.current.send('abc-2'))
    expect(result.current.notes.map((note) => [note.key, note.number])).toEqual([
      ['abc-1', 1],
      ['abc-2', 2],
    ])
  })
})

describe('a note waiting in the queue', () => {
  const queued = async () => {
    const hook = notesWithDraft(run({ status: 'running', promptQueue: [{ id: 'q1', text: 'x', createdAt: '' }] }))
    await act(() => hook.result.current.send('abc-1'))
    return hook
  }

  it('is reworded in place, element and all', async () => {
    const { result } = await queued()
    await act(() => result.current.saveQueued('abc-1', 'make it smaller'))
    const [id, queueId, message] = api.editQueuedRunPrompt.mock.calls[0] as [string, string, string]
    expect([id, queueId]).toEqual(['run-1', 'q1'])
    expect(message.startsWith('make it smaller\n\nElements selected in the app preview:')).toBe(true)
    expect(result.current.note('abc-1')).toMatchObject({ phase: 'queued', text: 'make it smaller', number: 1 })
  })

  it('is taken back out, frame and all', async () => {
    const { result } = await queued()
    await act(() => result.current.withdraw('abc-1'))
    expect(api.removeQueuedRunPrompt).toHaveBeenCalledWith('run-1', 'q1')
    expect(result.current.marks).toEqual([])
  })

  it('says so when it has already gone to the agent', async () => {
    const { result } = await queued()
    api.editQueuedRunPrompt.mockRejectedValue(new ApiError(404, 'not found'))
    await expect(act(() => result.current.saveQueued('abc-1', 'too late'))).rejects.toThrow(/already gone to the agent/)
  })

  it('follows the run: in queue → in progress → done', async () => {
    const hook = await queued()
    const phase = () => hook.result.current.note('abc-1')?.phase
    expect(phase()).toBe('queued')
    // Its turn: the engine took it off the queue and the run is working on it.
    hook.rerender({ current: run({ status: 'running', promptQueue: [] }) })
    expect(phase()).toBe('running')
    hook.rerender({ current: run({ status: 'waiting' }) })
    expect(phase()).toBe('done')
  })

  it('shows the agent\'s question instead of calling the note done', async () => {
    const hook = await queued()
    hook.rerender({ current: run({ status: 'running', promptQueue: [] }) })
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
  const at = (status: ApiRun['status'], ids: string[] = [], asking = false) => ({ status, queueIds: new Set(ids), asking })

  it('does not call a just-delivered note done before the run has been seen working', () => {
    // The send has returned; the run record this window holds still says `waiting`.
    const [note] = advance([sent({ deliveredAt: 1_000 })], at('waiting'), 1_500)
    expect(note!.phase).toBe('running')
  })

  it('finishes a note whose turn was too short to ever be seen, after a grace period', () => {
    const [note] = advance([sent({ deliveredAt: 1_000 })], at('waiting'), 30_000)
    expect(note!.phase).toBe('done')
  })

  it('keeps only the note delivered last in progress', () => {
    const next = advance(
      [sent({ key: 'a', deliveredAt: 1, sawRunning: true }), sent({ key: 'b', number: 2, phase: 'queued', queueId: 'q2', seenQueued: true })],
      at('running', []),
      50,
    )
    expect(next.map((note) => note.phase)).toEqual(['done', 'running'])
  })

  it('returns the same list when nothing moved, so nothing re-renders', () => {
    const list = [sent({ phase: 'queued', queueId: 'q1', seenQueued: true }), sent({ key: 'd', phase: 'done' })]
    expect(advance(list, at('running', ['q1']), 5)).toBe(list)
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

describe('noteMessage', () => {
  it('is the user\'s words first, then the one element', () => {
    const message = noteMessage({ key: 'abc-1', pick: PICK, text: '  make it bigger  ' })
    expect(message.startsWith('make it bigger\n\n')).toBe(true)
    expect(message.match(/^- `/gm)).toHaveLength(1)
  })
})

describe('the note popup', () => {
  const actions = () => ({ setText: vi.fn(), discard: vi.fn(), send: vi.fn(async () => {}), saveQueued: vi.fn(async () => {}), withdraw: vi.fn(async () => {}) })
  const note = (over: Partial<DesignNote>): DesignNote => ({ key: 'abc-1', pick: PICK, text: 'make it bigger', phase: 'draft', ...over })

  it('names the element, takes the prompt, and sends on Ctrl+Enter', async () => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({})} run={run({ status: 'waiting' })} notes={notes} onClose={onClose} />)
    expect(document.querySelector('[data-slot=design-note-element]')!.textContent).toBe('button.save')
    const field = screen.getByLabelText('Note for the agent')
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'make it bigger!' } })
    expect(notes.setText).toHaveBeenCalledWith('abc-1', 'make it bigger!')
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(notes.send).toHaveBeenCalledWith('abc-1'))
    // Sent: the frame stays, numbered; the window has done its job.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('cannot send an empty note', () => {
    render(<DesignNotePopup note={note({ text: '   ' })} run={run()} notes={actions()} onClose={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says what Send will do for a closed session', () => {
    render(<DesignNotePopup note={note({})} run={run({ status: 'done' })} notes={actions()} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Reopen & send' })).toBeTruthy()
  })

  it.each([
    ['✕', () => fireEvent.click(screen.getByRole('button', { name: 'Discard note' }))],
    ['Esc', () => fireEvent.keyDown(screen.getByLabelText('Note for the agent'), { key: 'Escape' })],
  ])('throws a draft away and deselects its element on %s', (_label, dismiss) => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({})} run={run()} notes={notes} onClose={onClose} />)
    dismiss()
    expect(notes.discard).toHaveBeenCalledWith('abc-1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft and says why when the send fails', async () => {
    const notes = actions()
    notes.send.mockRejectedValue(new Error('prompt queue is full — 20 prompts at most'))
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({})} run={run()} notes={notes} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('prompt queue is full — 20 prompts at most', { tone: 'danger' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(notes.discard).not.toHaveBeenCalled()
  })

  it('lets a waiting note be reworded or taken back', async () => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({ phase: 'queued', number: 2, queueId: 'q1' })} run={run()} notes={notes} onClose={onClose} />)
    expect(document.querySelector('[data-slot=design-note-status]')!.textContent).toBe('In queue')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Note for the agent'), { target: { value: 'make it smaller' } })
    // A rewording is a copy until saved: a half-typed edit is never what the agent receives.
    expect(notes.setText).not.toHaveBeenCalled()
    fireEvent.click(save)
    await waitFor(() => expect(notes.saveQueued).toHaveBeenCalledWith('abc-1', 'make it smaller'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from queue' }))
    await waitFor(() => expect(notes.withdraw).toHaveBeenCalledWith('abc-1'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it.each([
    ['running', 'In progress'],
    ['asking', 'Agent is waiting for your answer'],
    ['done', 'Done'],
  ] as const)('is read-only once the note is with the agent (%s)', (phase, label) => {
    const notes = actions()
    const onClose = vi.fn()
    render(<DesignNotePopup note={note({ phase, number: 1 })} run={run()} notes={notes} onClose={onClose} />)
    expect(document.querySelector('[data-slot=design-note-status]')!.textContent).toBe(label)
    expect(screen.queryByLabelText('Note for the agent')).toBeNull()
    expect(document.querySelector('[data-slot=design-note-text]')!.textContent).toBe('make it bigger')
    // Closing only hides it: nothing sent is thrown away.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(notes.discard).not.toHaveBeenCalled()
  })
})

describe('advance — a note just queued', () => {
  const queuedNote = (over: Record<string, unknown>) =>
    ({ key: 'k', pick: PICK, text: 't', number: 1, sawRunning: false, phase: 'queued', queueId: 'q1', ...over }) as never

  it('is not called delivered before the run record has listed it', () => {
    // The queue request returned; this window's run record does not show the entry yet.
    const [note] = advance([queuedNote({ queuedAt: 1_000 })], { status: 'running', queueIds: new Set(), asking: false }, 1_200)
    expect(note!.phase).toBe('queued')
  })

  it('is delivered once it was listed and then is not', () => {
    const listed = advance([queuedNote({ queuedAt: 1_000 })], { status: 'running', queueIds: new Set(['q1']), asking: false }, 1_200)
    const [note] = advance(listed, { status: 'running', queueIds: new Set(), asking: false }, 1_400)
    expect(note!.phase).toBe('running')
  })
})
