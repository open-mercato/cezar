import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ApiRun, RunEvent, RunStatus } from '@open-mercato/cezar-api-client'

import { OutcomeCard, failingCheck, outcomeKind, outcomeSentence } from './outcome-card'
import { ThreadView } from './task-thread'
import { reduceThread, threadFooter } from './thread-state'

const PROVIDERS = { providers: [{ provider: 'claude', status: 'connected', enabled: true }] }

function renderUi(ui: ReactElement) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const body = String(input) === '/api/v1/providers/status' ? PROVIDERS : []
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
    }),
  )
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/tasks/r1']}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const run = (status: RunStatus, extra: Partial<ApiRun> = {}): ApiRun =>
  ({
    id: 'r1',
    title: 'Merge main into the PR',
    workflow: 'quick-task',
    task: 'Merge main.',
    status,
    createdAt: '2026-11-11T12:00:00.000Z',
    startedAt: '2026-11-11T12:00:10.000Z',
    finishedAt: '2026-11-11T12:06:23.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...extra,
  }) as ApiRun

const line = (seq: number, type: string, rest: Record<string, unknown> = {}): RunEvent =>
  ({ seq, ts: '2026-11-11T12:00:00.000Z', type, ...rest }) as RunEvent

const message = (seq: number, text: string, role: 'assistant' | 'user' = 'assistant'): RunEvent =>
  line(seq, 'item.completed', { item: { kind: 'message', id: `m${seq}`, role, text } })

const EVENTS: RunEvent[] = [
  line(1, 'turn.started', { turnId: 't1' }),
  message(2, 'Looking at the branch first.'),
  message(3, '**Merged main**, resolved one docs conflict, commented on the PR with next steps.\n\nDetails below.'),
]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('outcomeSentence — the agent’s own last words, trimmed', () => {
  it('takes the first sentence of the last assistant message, without markdown', () => {
    expect(outcomeSentence(reduceThread(EVENTS))).toBe('Merged main, resolved one docs conflict, commented on the PR with next steps.')
  })

  it('falls back to the first line when there is no sentence end, and caps at ~160 characters', () => {
    const long = `# ${'word '.repeat(60).trim()}`
    const sentence = outcomeSentence(reduceThread([line(1, 'turn.started', { turnId: 't' }), message(2, long)]))
    expect(sentence?.length).toBeLessThanOrEqual(160)
    expect(sentence?.endsWith('…')).toBe(true)
    expect(sentence?.startsWith('word word')).toBe(true)
  })

  it('ignores user text and fences, and is undefined without assistant text', () => {
    expect(outcomeSentence(reduceThread([line(1, 'turn.started', { turnId: 't' }), message(2, 'Do it', 'user')]))).toBeUndefined()
    expect(outcomeSentence(reduceThread([line(1, 'turn.started', { turnId: 't' }), message(2, '```\nnpm test\n```\nAll green now.')]))).toBe('All green now.')
    expect(outcomeSentence(reduceThread([]))).toBeUndefined()
  })
})

describe('failingCheck and outcomeKind', () => {
  it('finds the failed check command and the head of its output', () => {
    const thread = reduceThread([
      line(1, 'check-output', { command: 'npm run typecheck', exitCode: 2, text: Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n') }),
    ])
    const check = failingCheck(thread)
    expect(check?.command).toBe('npm run typecheck')
    expect(check?.output.split('\n')).toHaveLength(7)
    expect(check?.output.endsWith('…')).toBe(true)
    expect(failingCheck(reduceThread([line(1, 'check-output', { command: 'npm test', exitCode: 0, text: 'ok' })]))).toBeUndefined()
  })

  it('names the state the card is in', () => {
    expect(outcomeKind({ status: 'review' })).toBe('review')
    expect(outcomeKind({ status: 'done' })).toBe('done')
    expect(outcomeKind({ status: 'failed' })).toBe('failed')
    expect(outcomeKind({ status: 'failed', idleClosedAt: 'x' })).toBe('idle')
    expect(outcomeKind({ status: 'running' })).toBeUndefined()
  })
})

describe('OutcomeCard — three states', () => {
  const footerFor = (fixture: ApiRun) => {
    const footer = threadFooter(fixture.status, fixture.error, fixture.awaitingAnswerSince !== undefined, fixture.idleClosedAt !== undefined, undefined)
    if (!footer || footer.state !== 'closed') throw new Error('expected a closed footer')
    return footer
  }

  it('finished at the gate: the sentence, the facts, Review changes primary and Open PR beside it', () => {
    const fixture = run('review', {
      diffStat: { adds: 68, dels: 15, files: 3 },
      pullRequestUrl: 'https://github.com/o/r/pull/1992',
      costUsd: 0.83,
      branch: 'cez/b616e4e0',
    })
    renderUi(<OutcomeCard run={fixture} thread={reduceThread(EVENTS)} footer={footerFor(fixture)} />)
    const card = document.querySelector('[data-slot="outcome-card"]') as HTMLElement
    expect(card.getAttribute('data-kind')).toBe('review')
    expect(screen.getByText('Finished · needs your review')).toBeTruthy()
    expect(card.querySelector('[data-slot="outcome-sentence"]')?.textContent).toBe(
      'Merged main, resolved one docs conflict, commented on the PR with next steps.',
    )
    const facts = card.querySelector('[data-slot="outcome-facts"]')?.textContent ?? ''
    expect(facts).toContain('3 files')
    expect(facts).toContain('+68 −15')
    expect(facts).toContain('1992')
    expect(facts).toContain('cez/b616e4e0')
    expect(facts).toContain('$0.83')
    expect(card.querySelector('[data-slot="outcome-time"]')?.textContent).toContain('6m 13s')
    const actions = card.querySelector('[data-slot="outcome-actions"]') as HTMLElement
    const review = actions.querySelector('[data-action="review"]') as HTMLAnchorElement
    expect(review.textContent).toBe('Review changes')
    expect(review.getAttribute('href')).toBe('/p/cezar/tasks/r1/changes')
    expect(actions.querySelector('[data-action="open-pr"]')?.getAttribute('href')).toBe('https://github.com/o/r/pull/1992')
    expect(actions.querySelector('[data-action="retry"]')).toBeNull()
    // The closing line stays, as the card's meta, with its PR link.
    expect(card.querySelector('[data-slot="thread-footer"]')?.textContent).toContain('Session closed — waiting for your review')
    expect(card.querySelector('[data-slot="thread-footer"] [data-slot="pr-link"]')).not.toBeNull()
  })

  it('failed: the step, the check output head, the cause, Retry primary with a hint beside it', async () => {
    const fixture = run('failed', {
      error: 'step "verify" failed: check exited with code 2',
      diffStat: { adds: 212, dels: 40, files: 5 },
      steps: [
        { id: 'implement', name: 'Implement', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 's1' },
        { id: 'verify', name: 'Verify', kind: 'check', status: 'failed', iterations: 1, tokensUsed: 0 },
        { id: 'review', name: 'Review', kind: 'agent', status: 'pending', iterations: 0, tokensUsed: 0 },
      ],
    })
    const thread = reduceThread([
      ...EVENTS,
      line(4, 'check-output', { command: 'npm run typecheck', exitCode: 2, text: "src/server/pr.ts(118,9): error TS2322: Type 'string | undefined'" }),
    ])
    const onContinue = vi.fn().mockResolvedValue(undefined)
    const onContinueWithHint = vi.fn()
    renderUi(
      <OutcomeCard
        run={fixture}
        thread={thread}
        footer={footerFor(fixture)}
        offerContinue
        onContinue={onContinue}
        onContinueWithHint={onContinueWithHint}
      />,
    )
    const card = document.querySelector('[data-slot="outcome-card"]') as HTMLElement
    expect(card.getAttribute('data-kind')).toBe('failed')
    expect(screen.getByText('Failed in step 2 of 3 · Verify')).toBeTruthy()
    expect(card.querySelector('[data-slot="outcome-check"]')?.textContent).toContain('npm run typecheck')
    expect(card.querySelector('[data-slot="outcome-check"]')?.textContent).toContain('error TS2322')
    const footer = card.querySelector('[data-slot="thread-footer"]') as HTMLElement
    expect(footer.textContent).toContain('check exited with code 2')
    expect(footer.className).toContain('text-danger')
    const actions = card.querySelector('[data-slot="outcome-actions"]') as HTMLElement
    const retry = actions.querySelector('[data-action="retry"]') as HTMLButtonElement
    expect(retry.textContent).toBe('Retry')
    fireEvent.click(retry)
    await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
    fireEvent.click(actions.querySelector('[data-action="continue-hint"]') as HTMLButtonElement)
    expect(onContinueWithHint).toHaveBeenCalledTimes(1)
    expect(actions.querySelector('[data-action="review"]')?.getAttribute('href')).toBe('/p/cezar/tasks/r1/changes')
    expect(actions.querySelector('[data-action="archive"]')).not.toBeNull()
  })

  it('done with a PR: Open PR is the primary, Review changes the secondary', () => {
    const fixture = run('done', { pullRequestUrl: 'https://github.com/o/r/pull/7', diffStat: { adds: 1, dels: 0, files: 1 } })
    renderUi(<OutcomeCard run={fixture} thread={reduceThread([])} footer={footerFor(fixture)} />)
    const actions = document.querySelector('[data-slot="outcome-actions"]') as HTMLElement
    expect([...actions.querySelectorAll('[data-action]')].map((el) => el.getAttribute('data-action'))).toEqual(['open-pr', 'review', 'archive'])
    expect(document.querySelector('[data-slot="outcome-sentence"]')).toBeNull()
    expect(document.querySelector('[data-slot="outcome-card"] [data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
  })

  it('asked a question: the thread keeps the ask card and renders no outcome card', async () => {
    const fixture = run('failed', {
      awaitingAnswerSince: '2026-11-11T12:06:23.000Z',
      steps: [{ id: 'task', name: 'Task', kind: 'agent', status: 'failed', iterations: 1, tokensUsed: 0, sessionId: 's1' }],
    })
    const thread = reduceThread([
      line(1, 'turn.started', { turnId: 't1' }),
      line(2, 'ask.requested', {
        requestId: 'ask-1',
        questions: [
          {
            header: 'Env var',
            question: 'Keep the legacy env var as a fallback?',
            multiSelect: false,
            options: [{ label: 'Yes', description: 'Keep it' }, { label: 'No', description: 'Drop it' }],
          },
        ],
      }),
    ])
    renderUi(<ThreadView run={fixture} thread={thread} />)
    await waitFor(() => expect(document.querySelector('[data-slot="ask-card"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="outcome-card"]')).toBeNull()
    expect(document.querySelector('[data-slot="thread-footer"]')?.textContent).toContain('waiting for your answer')
  })

  it('the thread ends in the card for a closed run', async () => {
    renderUi(<ThreadView run={run('review', { diffStat: { adds: 2, dels: 1, files: 1 } })} thread={reduceThread(EVENTS)} />)
    await waitFor(() => expect(document.querySelector('[data-slot="outcome-card"]')).not.toBeNull())
    expect(document.querySelectorAll('[data-slot="thread-footer"]')).toHaveLength(1)
  })
})
