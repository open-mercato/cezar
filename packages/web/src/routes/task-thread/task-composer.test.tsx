import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import type { QuoteCapture } from '@/components/quote-selection'
import type { MessageQuote } from '@/lib/message-quotes'
import type { ApiRun } from '@open-mercato/cezar-api-client'

import type { DiffComment, DiffComments } from './diff-comments'
import type { ContinueAction } from './follow-up-engine'
import type { MessageQuotes } from './message-quotes-store'
import { TaskComposer } from './task-composer'
import type { Draft } from './thread-draft'

const deliver = vi.fn(async (_text: string, _images: unknown) => ({ ok: true }))
let skills: { name: string }[] | undefined

vi.mock('./deliver-prompt', () => ({ useDeliverPrompt: () => deliver }))
vi.mock('./active-provider', () => ({ useActiveProviderAvailability: () => ({ usable: true }) }))
vi.mock('./run-confirm-dialog', () => ({ useStopRun: () => ({ request: () => {}, pending: false, dialog: null }) }))
vi.mock('./run-engine', () => ({ RunEnginePills: () => null }))
vi.mock('@/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/queries')>()),
  useSkills: (enabled: boolean) => ({ data: enabled ? skills : undefined }),
}))

beforeEach(() => {
  deliver.mockClear()
  skills = []
})
afterEach(() => {
  act(() => resetToasts())
  cleanup()
})

const RUN = { id: 'r1', status: 'waiting', steps: [] } as unknown as ApiRun
const QUOTE: MessageQuote = { id: 'q1', ref: 2, role: 'assistant', excerpt: 'the quoted words', code: false, body: 'why?' }
const COMMENT: DiffComment = { id: 'c1', path: 'src/a.ts', side: 'new', line: 3, body: 'note', excerpt: 'x' }

const CONTINUE: ContinueAction = {
  available: false,
  canContinue: false,
  providerPending: false,
  pills: null,
  engine: null,
  effort: null,
  effortOffered: false,
  continueWith: async () => ({}) as never,
} as unknown as ContinueAction

function fakeList<T>(items: T[]) {
  const submitted: T[][] = []
  return {
    submitted,
    submit: async <R,>(send: (held: T[]) => Promise<R>) => {
      const result = await send(items)
      submitted.push(items)
      return result
    },
  }
}

function setup({ quotes = [QUOTE], comments = [] as DiffComment[], quoteSelection = null as QuoteCapture | null, onQuoteSelection = undefined as ((capture: QuoteCapture) => void) | undefined } = {}) {
  const q = fakeList(quotes)
  const c = fakeList(comments)
  const messageQuotes: MessageQuotes = { ready: true, quotes, add: () => true, update: () => true, remove: () => {}, submit: q.submit }
  const diffComments: DiffComments = {
    ready: true,
    comments,
    add: () => true,
    update: () => true,
    remove: () => {},
    clear: () => {},
    submit: c.submit,
  }
  function Host() {
    const [text, setText] = useState('')
    const draft = {
      ready: true,
      hasDraft: text !== '',
      text,
      setText,
      images: [],
      setImages: () => {},
      submit: <R,>(send: () => Promise<R>) => send(),
    } as unknown as Draft
    return <TaskComposer run={RUN} draft={draft} diffComments={diffComments} messageQuotes={messageQuotes} quoteSelection={quoteSelection} onQuoteSelection={onQuoteSelection} continueAction={CONTINUE} />
  }
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Host />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const box = screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement
  const send = (text: string) => {
    fireEvent.change(box, { target: { value: text } })
    fireEvent.click(box.closest('[data-slot="composer"]')!.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!)
  }
  return { send, quotesSent: q.submitted, commentsSent: c.submitted }
}

describe('TaskComposer with quotes', () => {
  it('sends a backend slash command alone and keeps the quotes', async () => {
    const { send, quotesSent } = setup()
    send('/compact')
    await waitFor(() => expect(deliver).toHaveBeenCalledWith('/compact', []))
    expect(quotesSent).toEqual([])
    expect(await screen.findByText(/^Quotes kept — \/compact is a command/)).not.toBeNull()
  })

  it('names both kinds when quotes and diff comments are kept', async () => {
    const { send, quotesSent, commentsSent } = setup({ comments: [COMMENT] })
    send('/compact')
    await waitFor(() => expect(deliver).toHaveBeenCalledWith('/compact', []))
    expect(quotesSent).toEqual([])
    expect(commentsSent).toEqual([])
    expect(await screen.findByText(/^Quotes and diff comments kept — \/compact/)).not.toBeNull()
  })

  it('fetches the skill catalog for quotes alone, so a registry skill carries them', async () => {
    skills = [{ name: 'fix-it' }]
    const { send, quotesSent } = setup()
    send('/fix-it now')
    await waitFor(() => expect(deliver).toHaveBeenCalled())
    expect(deliver.mock.calls[0]![0]).toMatch(/^\/fix-it now\n\nQuoted from the conversation:/)
    expect(quotesSent).toEqual([[QUOTE]])
  })

  it('never folds the quotes into an Alt quick reply', async () => {
    const { quotesSent } = setup()
    fireEvent.keyDown(window, { code: 'KeyC', key: 'c', altKey: true })
    await waitFor(() => expect(deliver).toHaveBeenCalledWith('Continue.', []))
    expect(quotesSent).toEqual([])
  })

  it('refuses an over-long message naming both kinds', async () => {
    const { send, quotesSent } = setup({ comments: [COMMENT] })
    send('x'.repeat(100_000))
    expect(await screen.findByText(/Too long with the quote and the diff comment attached/)).not.toBeNull()
    expect(deliver).not.toHaveBeenCalled()
    expect(quotesSent).toEqual([])
  })

  it('offers the touch "Quote selection" chip while a capture exists, even with no quotes yet', () => {
    const capture: QuoteCapture = { source: document.createElement('div'), excerpt: 'picked words', code: false, role: 'assistant', ref: 3 }
    const onQuoteSelection = vi.fn()
    setup({ quotes: [], quoteSelection: capture, onQuoteSelection })
    const chip = screen.getByRole('button', { name: 'Quote selection' })
    expect(chip.getAttribute('data-slot')).toBe('quote-selection-chip')
    expect(chip.hasAttribute('data-quote-action')).toBe(true)
    fireEvent.click(chip)
    expect(onQuoteSelection).toHaveBeenCalledWith(capture)
  })

  it('shows no chip without a capture', () => {
    setup({ quotes: [], onQuoteSelection: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Quote selection' })).toBeNull()
  })
})
