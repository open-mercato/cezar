import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FrameworkFile } from '@open-mercato/cezar-api-client'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { cardAtGate, cardInConversation, cardRun, HUMAN_ASK } from '@/lib/card-fixtures'
import type { CardRun } from '@/lib/cards'
import { CardWizard } from './card-wizard'

/** The card wizard's gate body (spec 2026-11-15-framework-board, mockup 2). */

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const NAMES = new Map([
  ['plan', 'Plan'],
  ['build', 'Build'],
  ['review', 'Review'],
])
const FRAMEWORK: FrameworkFile = {
  id: 'generic',
  name: 'Generic',
  stages: [
    { id: 'plan', name: 'Plan', artifacts: ['.ai/cezar/plans/*.md'], gate: { kind: 'approve' } },
    { id: 'build', name: 'Build' },
    { id: 'review', name: 'Review', review: true },
  ],
}

let posts: { url: string; body: unknown }[] = []
beforeEach(() => {
  posts = []
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

function wizard(run: CardRun) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <CardWizard run={run} framework={FRAMEWORK} frameworkName="Generic" names={NAMES} thread={{ turns: [] }} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('card wizard — gate', () => {
  it('approves a framework gate through the approve route after a confirm naming the change and the stage', async () => {
    wizard(cardAtGate('plan', { id: 'card-1', branch: 'cez/card1' }, ))
    const gate = document.querySelector('[data-slot="card-gate"]') as HTMLElement
    expect(within(gate).getByText('⏸ Approve Plan to start Build')).toBeTruthy()
    // A framework gate has no Request changes (that is the framework's own loop).
    expect(within(gate).queryByRole('button', { name: /Request changes/ })).toBeNull()

    fireEvent.click(within(gate).getByRole('button', { name: 'Approve & continue → Build' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Approve Plan and start Build?')
    expect(dialog.textContent).toContain('cez/card1')
    expect(posts).toEqual([])

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve & continue → Build' }))
    await waitFor(() => expect(posts).toEqual([{ url: '/api/v1/cards/card-1/approve', body: {} }]))
  })

  it('answers a gate.human through the ask-answer path, and sends Request changes with the comment', async () => {
    const run = cardAtGate('plan', { id: 'card-2', asks: [HUMAN_ASK] })
    wizard(run)
    const gate = document.querySelector('[data-slot="card-gate"]') as HTMLElement

    const request = within(gate).getByRole('button', { name: /Request changes → re-run Plan \(loop 1\/2\)/ }) as HTMLButtonElement
    expect(request.disabled).toBe(true) // the comment is required
    fireEvent.change(within(gate).getByLabelText('What should change'), { target: { value: 'Split the plan in two' } })
    fireEvent.click(request)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.url).toBe('/api/v1/runs/card-2/messages')
    expect(posts[0]!.body).toMatchObject({ text: 'Approval: Request changes: Split the plan in two', askRequestId: 'q1' })

    fireEvent.click(within(gate).getByRole('button', { name: 'Approve & continue → Build' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve & continue → Build' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]!.body).toMatchObject({ text: 'Approval: Approve', askRequestId: 'q1' })
  })

  it('offers Let the agent decide and Finish stage in a conversation stage, with the run’s thread', async () => {
    wizard(cardInConversation({ id: 'card-3' }))
    expect(document.querySelector('[data-slot="card-chat"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Finish stage → Build' }))
    await waitFor(() => expect(posts).toEqual([{ url: '/api/v1/cards/card-3/finish-stage', body: {} }]))
    fireEvent.click(screen.getByRole('button', { name: '🤖 Let the agent decide' }))
    await waitFor(() => expect(posts[1]).toEqual({ url: '/api/v1/cards/card-3', body: { autonomous: true } }))
  })

  it('never offers Finish stage without the engine’s conversation flag — a question park or an interactive tail', () => {
    const ask = { ...HUMAN_ASK, questions: [{ header: 'Scope', question: 'Which module?', options: [] }] }
    wizard(cardRun({ id: 'card-5', status: 'waiting', asks: [ask], graphState: { loops: {}, taken: [], cursor: 'plan-agent' } }, { stages: { plan: 'waiting', build: 'pending', review: 'pending' } }))
    expect(screen.queryByRole('button', { name: /Finish stage/ })).toBeNull()
    expect(screen.queryByText(/your turn/)).toBeNull()
  })

  it('hides Approve on a gate the framework confirms itself, and says why', () => {
    wizard(cardAtGate('plan', { id: 'card-6' }, { kind: 'framework', approve: null }))
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    expect(screen.getByText(/confirmed by the framework’s own `done plan`/)).toBeTruthy()
  })

  it('shows a card re-queued mid-walk as waiting for a slot, with no way back to the Backlog', () => {
    wizard(cardRun({ id: 'card-7', status: 'queued', graphState: { loops: {}, taken: [], cursor: 'build-agent' } }, { stage: 'build', stages: { plan: 'done', build: 'running', review: 'pending' } }))
    expect(screen.getByText('Build — waiting for a slot')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to Backlog' })).toBeNull()
  })

  it('names the blocker of a card parked at a full stage', () => {
    wizard(cardRun({ id: 'card-4', status: 'waiting' }, { blocked: { reason: 'wip', since: '2026-11-23T10:00:00.000Z' } }))
    expect(screen.getByText('⏸ Plan is full (WIP)')).toBeTruthy()
  })
})

describe('card wizard — stepper', () => {
  it('lays the stepper out as the framework’s stages plus Ship, the current one marked', () => {
    wizard(cardAtGate('build', { id: 'card-8' }))
    const steps = [...document.querySelectorAll('[data-slot="card-stepper"] [data-stage]')]
    expect(steps.map((s) => [s.getAttribute('data-stage'), s.getAttribute('data-state')])).toEqual([
      ['plan', 'done'],
      ['build', 'waiting'],
      ['review', 'pending'],
      ['ship', 'pending'],
    ])
    expect(steps[1]!.getAttribute('aria-current')).toBe('step')
  })
})

describe('card wizard — a question the restart closed', () => {
  const stages = { plan: 'failed', build: 'pending', review: 'pending' } as const
  it('shows the question, not a failure, with Re-run as a secondary action', () => {
    wizard(cardRun({ id: 'card-q', status: 'failed', runner: 'claude', awaitingAnswerSince: '2026-11-23T11:00:00.000Z' }, { stages: { ...stages } }))
    const body = document.querySelector('[data-slot="card-body"]') as HTMLElement
    expect(within(body).getByText('❓ Plan — a question for you')).toBeTruthy()
    expect(body.textContent).toContain('Claude Code asked — answer to continue (the session ended; sending reopens it).')
    expect(body.textContent).not.toContain('failed')
    expect(body.querySelector('[data-slot="card-chat"]')).toBeTruthy()
    expect(within(body).getByRole('button', { name: 'Re-run Plan' })).toBeTruthy()
    const dot = document.querySelector('[data-slot="card-stepper"] [data-stage="plan"]')!
    expect(dot.getAttribute('data-state')).toBe('waiting')
  })

  it('keeps a plain failure a failure', () => {
    wizard(cardRun({ id: 'card-f', status: 'failed' }, { stages: { ...stages } }))
    const body = document.querySelector('[data-slot="card-body"]') as HTMLElement
    expect(within(body).getByText('✕ Plan failed')).toBeTruthy()
    expect(document.querySelector('[data-slot="card-stepper"] [data-stage="plan"]')!.getAttribute('data-state')).toBe('failed')
  })
})
