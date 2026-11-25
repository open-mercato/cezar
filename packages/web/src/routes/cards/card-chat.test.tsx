import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FrameworkFile, RunEvent } from '@open-mercato/cezar-api-client'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { cardInConversation } from '@/lib/card-fixtures'
import { stripControlMarkers, type CardRun } from '@/lib/cards'
import { resetAskSelections } from '../task-thread/ask-selections'
import { reduceThread } from '../task-thread/thread-state'
import { chatRows } from './card-chat-rows'
import { CardWizard } from './card-wizard'

/** The card wizard's compact chat (spec 2026-11-15-framework-board, mockup 3). */

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const NAMES = new Map([
  ['plan', 'Discovery'],
  ['build', 'Spec'],
  ['review', 'Review'],
])
const FRAMEWORK: FrameworkFile = {
  id: 'generic',
  name: 'Generic',
  stages: [
    { id: 'plan', name: 'Discovery', mode: 'conversation', skill: 'om-discovery', artifacts: ['briefs/*-discovery.md'] },
    { id: 'build', name: 'Spec' },
    { id: 'review', name: 'Review', review: true },
  ],
}

let posts: { url: string; body: unknown }[] = []
beforeEach(() => {
  posts = []
  resetAskSelections()
  setApiScope(null)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method && init.method !== 'GET') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        if (url.includes('/messages')) return json({ ok: true, delivered: true })
        return json({ ok: true })
      }
      if (url.endsWith('/health')) return json({ capabilities: { localHandoff: true } })
      if (url.endsWith('/providers/status')) return json({ providers: [{ provider: 'claude', status: 'connected', enabled: true }] })
      if (url.includes('/runs') || url.includes('/drafts')) return json([])
      return json({})
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const event = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent => ({ seq, ts: '2026-11-23T10:00:00.000Z', type, ...rest }) as RunEvent
const say = (seq: number, text: string) => event(seq, 'item.completed', { item: { kind: 'message', id: `m${seq}`, role: 'assistant', text } })
const tool = (seq: number, title: string) =>
  event(seq, 'item.completed', { item: { kind: 'tool', id: `t${seq}`, name: 'Bash', toolKind: 'execute', title, status: 'completed' } })
const QUESTIONS = [
  { header: 'Reserve', question: 'When should stock be reserved?', options: [{ label: 'At checkout start' }, { label: 'At payment' }] },
  { header: 'Warehouse', question: 'Which warehouse fulfils a mixed order?', options: [{ label: 'Fewest shipments' }, { label: 'Nearest' }] },
]

function wizard(events: RunEvent[], run: CardRun = cardInConversation({ id: 'card-chat', runner: 'claude' })) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <CardWizard run={run} framework={FRAMEWORK} frameworkName="Generic" names={NAMES} thread={reduceThread(events)} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return document.querySelector('[data-slot="card-body"]') as HTMLElement
}

const messagePosts = (id = 'card-chat') => posts.filter((p) => p.url === `/api/v1/runs/${id}/messages`)

describe('card chat rows', () => {
  it('renders AI and Me badges, folds tool calls into one line, and strips control markers', () => {
    const body = wizard([
      tool(1, 'Ran ls modules/inventory'),
      tool(2, 'Read modules/inventory/stock.ts'),
      say(3, 'I read the inventory module.\nCEZ:VERDICT approve'),
      event(4, 'user-message', { text: 'Checkout start, 15 min TTL.' }),
      say(5, 'Got it. I have enough to write the spec.\n\nCEZ:STAGE-DONE'),
      say(6, 'One more thing.\nCEZ:ASK {"questions":[]}'),
    ])
    const rows = [...body.querySelectorAll('[data-slot="chat-row"]')]
    expect(rows.map((r) => r.querySelector('[data-slot="chat-badge"]')!.textContent)).toEqual(['AI', 'Me', 'AI', 'AI'])
    expect(body.querySelector('[data-slot="chat-tools"]')!.textContent).toContain('ran 2 tools')
    expect(body.textContent).not.toMatch(/CEZ:/)
    expect(body.textContent).toContain('Checkout start, 15 min TTL.')
    fireEvent.click(within(body.querySelector('[data-slot="chat-tools"]') as HTMLElement).getByRole('button'))
    expect(body.textContent).toContain('Read modules/inventory/stock.ts')
  })

  it('strips markers without eating prose that merely names one', () => {
    expect(stripControlMarkers('as CEZ:ASK requires, I will ask.\nCEZ:ASK {"questions":[]}')).toBe('as CEZ:ASK requires, I will ask.')
    expect(stripControlMarkers('done CEZ:STAGE-DONE')).toBe('done')
  })

  it('does not repeat a form answer as a Me row', () => {
    const events = [
      event(1, 'ask.requested', { requestId: 'a1', questions: QUESTIONS }),
      event(2, 'user-message', { text: 'Reserve: At checkout start\nWarehouse: Nearest' }),
    ]
    const rows = chatRows(reduceThread(events, { trackedAsks: [] }))
    expect(rows.map((r) => r.kind)).toEqual(['ask'])
  })
})

describe('card chat asks', () => {
  it('answers a two-question ask through chips with the task view’s request', async () => {
    const body = wizard([say(1, 'Before writing the spec I need two decisions.'), event(2, 'ask.requested', { requestId: 'ask-disc', questions: QUESTIONS })])
    expect(within(body).getByText('When should stock be reserved?')).toBeTruthy()
    const send = within(body).getByRole('button', { name: 'Send answers' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(within(body).getByRole('button', { name: 'At checkout start' }))
    expect(within(body).getByRole('button', { name: 'At checkout start' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(body).getAllByRole('button', { name: 'Other…' })[1]!)
    fireEvent.change(within(body).getByLabelText('Your own answer: Which warehouse fulfils a mixed order?'), { target: { value: 'never split a bundle' } })
    expect(messagePosts()).toEqual([])
    fireEvent.click(send)
    await waitFor(() => expect(messagePosts()).toHaveLength(1))
    expect(messagePosts()[0]!.body).toMatchObject({ askRequestId: 'ask-disc', text: 'Reserve: At checkout start\nWarehouse: never split a bundle' })
  })

  it('renders the engine’s stage-done ask as the mockup’s box and answers Yes', async () => {
    const body = wizard([
      say(1, 'Got it. CEZ:STAGE-DONE'),
      event(2, 'ask.requested', {
        requestId: 'done-1',
        source: 'workflow',
        questions: [{ header: 'Finish stage', question: 'The agent thinks "Discovery" is done. Finish this stage?', options: [{ label: 'Yes' }, { label: 'Not yet' }] }],
      }),
    ])
    const box = body.querySelector('[data-slot="chat-stage-done"]') as HTMLElement
    expect(box.textContent).toContain('Discovery looks complete — move on to Spec?')
    expect(within(box).getByRole('button', { name: 'Not yet — more questions' })).toBeTruthy()
    expect(within(box).queryByRole('button', { name: 'Other…' })).toBeNull()
    fireEvent.click(within(box).getByRole('button', { name: 'Yes, finish Discovery' }))
    await waitFor(() => expect(messagePosts()).toHaveLength(1))
    expect(messagePosts()[0]!.body).toMatchObject({ askRequestId: 'done-1', text: 'Finish stage: Yes' })
  })

  it('labels the submit Send answer & reopen when the session has ended', () => {
    const run = cardInConversation({ id: 'card-closed', runner: 'claude', status: 'failed', awaitingAnswerSince: '2026-11-23T11:00:00.000Z', steps: [{ id: 'plan-agent', status: 'failed', sessionId: 's1' }] as CardRun['steps'] })
    const body = wizard([event(1, 'ask.requested', { requestId: 'a2', questions: QUESTIONS })], run)
    expect(within(body).getByRole('button', { name: 'Send answer & reopen' })).toBeTruthy()
  })
})

describe('card chat composer and panel', () => {
  it('sends a reply from the composer, and offers Let the agent decide and Finish stage → Spec', async () => {
    const body = wizard([say(1, 'Before writing the spec I need two decisions.')])
    const composer = body.querySelector('[data-slot="card-composer"]') as HTMLElement
    expect(within(composer).getByRole('button', { name: '🤖 Let the agent decide' })).toBeTruthy()
    expect(within(composer).getByRole('button', { name: 'Finish stage → Spec' })).toBeTruthy()
    fireEvent.change(within(composer).getByPlaceholderText('Reply to the agent…'), { target: { value: 'Checkout start, 15 min TTL.' } })
    fireEvent.click(within(composer).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(messagePosts()).toHaveLength(1))
    expect(messagePosts()[0]!.body).toMatchObject({ text: 'Checkout start, 15 min TTL.' })
    expect(messagePosts()[0]!.body).not.toHaveProperty('askRequestId')

    fireEvent.click(within(composer).getByRole('button', { name: 'Finish stage → Spec' }))
    await waitFor(() => expect(posts.some((p) => p.url === '/api/v1/cards/card-chat/finish-stage')).toBe(true))
  })

  it('shows the STAGE and NEXT side panel beside the chat from lg up', () => {
    wizard([])
    const side = document.querySelector('[data-slot="card-side"]') as HTMLElement
    expect(side.parentElement!.className).toContain('lg:grid-cols-[minmax(0,1fr)_280px]')
    expect(document.getElementById('card-side-body')!.className).toContain('lg:flex')
    expect(side.textContent).toContain('💬 Conversation')
    expect(side.textContent).toContain('om-discovery')
    expect(side.textContent).toContain('briefs/*-discovery.md')
    expect(side.textContent).toContain('Spec starts in a new session. It reads the Discovery artifact and the card, not this chat.')
    expect(side.textContent).not.toContain('Gate')
  })

  it('marks the current stage dot amber 💬 in a conversation', () => {
    wizard([])
    const dot = document.querySelector('[data-slot="card-stepper"] [data-stage="plan"]')!
    expect(dot.getAttribute('data-state')).toBe('waiting')
    expect(dot.textContent).toContain('💬')
  })
})
