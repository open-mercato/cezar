import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, RunEvent, UiToolItem } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { sameData } from '@/lib/same-data'

import claudeSubagent from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import codexReview from '../../../../cezar/src/core/__fixtures__/codex/review-mode.expected.json'
import opencodeSubtask from '../../../../cezar/src/core/__fixtures__/opencode/subtask-nested.expected.json'

import {
  SessionTranscript,
  agentTranscriptSections,
  buildTranscriptRows,
  mainTranscriptSections,
  quoteTargetRowKey,
  useQuoteJump,
  type TranscriptRowModel,
  type TranscriptSection,
} from './session-transcript'
import { clearThreadScrollCaches } from './thread-scroll'
import { collectSubagents, subagentChildren } from './subagent-dock'
import { reduceThread, type ThreadEntry, type ThreadState } from './thread-state'

const quoteMocks = vi.hoisted(() => ({ capture: null as null | { source: HTMLElement; excerpt: string; code: boolean; role: 'assistant' | 'user' }, toast: vi.fn() }))
vi.mock('@/components/quote-selection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/quote-selection')>()),
  useMessageSelection: () => quoteMocks.capture,
}))
vi.mock('@/components/ui/toaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/toaster')>()),
  toast: quoteMocks.toast,
}))

beforeEach(() => {
  quoteMocks.capture = null
  quoteMocks.toast.mockClear()
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
  vi.unstubAllGlobals()
  clearThreadScrollCaches()
})

const tool = (id: string, overrides: Partial<UiToolItem> = {}): UiToolItem => ({
  kind: 'tool',
  id,
  name: 'Read',
  toolKind: 'read',
  title: `Read ${id}.ts`,
  status: 'completed',
  ...overrides,
})

const run = (overrides: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'Shared transcript',
  workflow: 'quick-task',
  task: 'Initial prompt',
  status: 'running',
  createdAt: '2026-07-31T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  ...overrides,
}) as ApiRun

const asRunEvents = (events: object[]): RunEvent[] =>
  events.map((event, index) => ({
    seq: index + 1,
    ts: '2026-07-31T00:00:00.000Z',
    ...event,
  })) as RunEvent[]

describe('transcript adapters and row building', () => {
  it('resolves sent quote role/ref metadata to stable rows, including rows outside the virtual DOM', () => {
    const rows = buildTranscriptRows([
      { id: 'task', userMessageKey: 'task', userMessage: { text: 'Prompt' }, entries: [] },
      {
        id: 'turn-seq-7',
        userMessage: { text: 'Follow up' },
        entries: [{ kind: 'message', id: 'answer', role: 'assistant', text: 'Answer' }],
      },
    ], 'r1')

    expect(quoteTargetRowKey(rows, { role: 'user', ref: 0 })).toBe('task')
    expect(quoteTargetRowKey(rows, { role: 'user', ref: 7 })).toBe('turn-seq-7:user')
    expect(quoteTargetRowKey(rows, { role: 'assistant', ref: 7 })).toBe('turn-seq-7:answer')
    expect(quoteTargetRowKey(rows, { role: 'assistant', ref: 99 })).toBeUndefined()
  })

  it('lands an assistant quote on the message holding its first line, else the turn\'s first message', () => {
    const rows = buildTranscriptRows([{
      id: 'turn-seq-4',
      userMessageKey: 'turn-seq-4:user',
      userMessage: { text: 'Go' },
      entries: [
        tool('t1'),
        { kind: 'message', id: 'm1', role: 'assistant', text: 'First **answer** here.' },
        { kind: 'message', id: 'm2', role: 'assistant', text: 'The migration keeps the `old` column.\nMore.' },
      ],
    }], 'r1')

    expect(quoteTargetRowKey(rows, { role: 'assistant', ref: 4, excerpt: 'keeps the old column.\nMore.' })).toBe('turn-seq-4:m2')
    expect(quoteTargetRowKey(rows, { role: 'assistant', ref: 4, excerpt: 'First answer' })).toBe('turn-seq-4:m1')
    expect(quoteTargetRowKey(rows, { role: 'assistant', ref: 4, excerpt: 'edited away' })).toBe('turn-seq-4:m1')
    // A sent card's locator is the turn scope, not a row: it resolves by ref.
    expect(quoteTargetRowKey(rows, { role: 'assistant', ref: 4, rowKey: 'turn-seq-4', excerpt: 'old column' })).toBe('turn-seq-4:m2')
  })

  it('resolves the reply to the task (assistant ref 0) to the first seq-less turn', () => {
    const rows = buildTranscriptRows([
      { id: 'task', userMessageKey: 'task', userMessage: { text: 'Do it' }, entries: [] },
      { id: 'turn-fallback-1', entries: [{ kind: 'message', id: 'a1', role: 'assistant', text: 'Done: the first reply.' }] },
      { id: 'turn-seq-9', userMessageKey: 'turn-seq-9:user', userMessage: { text: 'More' }, entries: [{ kind: 'message', id: 'a2', role: 'assistant', text: 'Second' }] },
    ], 'r1')
    // A sent card's locator matches no row, so the jump resolves it (and pages back first).
    expect(quoteTargetRowKey(rows, { role: 'assistant', ref: 0, excerpt: 'first reply' })).toBe('turn-fallback-1:a1')
    expect(quoteTargetRowKey(rows, { role: 'user', ref: 0 })).toBe('task')
    // A window that starts mid-history has no first turn to land on.
    expect(quoteTargetRowKey(rows.filter((row) => row.scope !== 'turn-fallback-1'), { role: 'assistant', ref: 0, excerpt: 'x' })).toBeUndefined()
  })

  it('preserves initial images, queued messages, turn messages, and established row keys', () => {
    const state: ThreadState = {
      turns: [
        {
          id: 'turn-1',
          userMessage: { text: 'Follow up', imageCount: 1, images: ['/turn.png'] },
          items: [{ kind: 'message', id: 'answer', role: 'assistant', text: 'Done' }],
        },
      ],
    }
    const sections = mainTranscriptSections(
      run({
        taskImages: ['/task.png'],
        queuedMessages: [
          { id: 'm1', text: 'Queued note', images: ['/queued.png'], createdAt: '2026-07-31T00:00:01.000Z' },
        ],
      }),
      state,
    )

    expect(sections.map((section) => section.id)).toEqual(['task', 'queued:m1', 'turn-1'])
    expect(sections[0]?.userMessage?.images).toEqual(['/task.png'])
    expect(sections[2]?.userMessage).toMatchObject({ text: 'Follow up', imageCount: 1 })
    expect(buildTranscriptRows(sections, 'r1').map((row) => row.key)).toEqual([
      'task',
      'queued:m1',
      'turn-1:user',
      'turn-1:answer',
    ])
  })

  it('re-folds equal events into value-equal rows and changes only the live tail', () => {
    const events = (tail: string): RunEvent[] =>
      asRunEvents([
        { type: 'item.completed', item: { kind: 'message', id: 'm1', role: 'assistant', text: 'Settled prose' } },
        { type: 'item.completed', item: { kind: 'tool', id: 't1', name: 'Bash', toolKind: 'execute', title: 'Ran npm test', status: 'completed', output: 'all green' } },
        { type: 'item.updated', item: { kind: 'message', id: 'm2', role: 'assistant', text: tail } },
      ])
    const rowsFor = (tail: string) =>
      buildTranscriptRows(mainTranscriptSections(run(), reduceThread(events(tail))), 'r1')

    const before = rowsFor('Wri')
    const same = rowsFor('Wri')
    expect(same).not.toBe(before)
    expect(same.every((row, index) => sameData(row, before[index]))).toBe(true)

    const grown = rowsFor('Writing')
    expect(grown).toHaveLength(before.length)
    expect(grown.filter((row, index) => !sameData(row, before[index]))).toHaveLength(1)
  })

  /**
   * Per-turn timestamps (#941): the adapters carry the stamps that already exist — the run
   * record's `createdAt` for the initial prompt, a queued message's own `createdAt`, and the
   * turn's event stamps — and the row builder turns the day changes and the turn completions
   * into rows OF THEIR OWN, so no existing row changes height.
   */
  describe('per-turn timestamps (#941)', () => {
    /** Built from local components so the local-day assertions hold in any timezone. */
    const localIso = (year: number, month: number, day: number, hour = 12, minute = 0): string =>
      new Date(year, month - 1, day, hour, minute).toISOString()

    const turn = (id: string, stamps: { user?: string; startedAt?: string; completedAt?: string }) => ({
      id,
      items: [{ kind: 'message', id: `${id}-answer`, role: 'assistant', text: 'Done' }],
      ...(stamps.user !== undefined
        ? { userMessage: { text: 'Follow up', imageCount: 0, images: [], ts: stamps.user } }
        : {}),
      ...(stamps.startedAt !== undefined ? { startedAt: stamps.startedAt } : {}),
      ...(stamps.completedAt !== undefined
        ? { completed: { stopReason: 'end_turn' as const, ts: stamps.completedAt } }
        : {}),
    })

    it('stamps the initial prompt, the queued messages and the turns from what is persisted', () => {
      const sections = mainTranscriptSections(
        run({
          createdAt: '2026-07-31T08:00:00.000Z',
          queuedMessages: [{ id: 'm1', text: 'Queued note', createdAt: '2026-07-31T08:00:30.000Z' }],
        }),
        {
          turns: [
            turn('turn-1', {
              user: '2026-07-31T08:01:00.000Z',
              startedAt: '2026-07-31T08:01:00.000Z',
              completedAt: '2026-07-31T08:05:12.000Z',
            }),
          ],
        } as ThreadState,
      )
      expect(sections[0]?.userMessage?.ts).toBe('2026-07-31T08:00:00.000Z')
      // A queued message is stamped with when it was QUEUED — the turn's own ts takes over once sent.
      expect(sections[1]?.userMessage?.ts).toBe('2026-07-31T08:00:30.000Z')
      expect(sections[2]?.userMessage?.ts).toBe('2026-07-31T08:01:00.000Z')
      expect(sections[2]?.startedAt).toBe('2026-07-31T08:01:00.000Z')
      expect(sections[2]?.completedAt).toBe('2026-07-31T08:05:12.000Z')
    })

    it('opens an attachment-only task with its attachments (telemetry 18c930de)', () => {
      const sections = mainTranscriptSections(run({ task: '', taskImages: ['/task.png'] }), { turns: [] } as unknown as ThreadState)
      expect(sections[0]?.userMessage).toMatchObject({ text: '', images: ['/task.png'] })
    })

    it('leaves an unstamped turn and an attributed agent section without a clock', () => {
      const sections = mainTranscriptSections(run({ task: '' }), {
        turns: [{ id: 'turn-1', userMessage: { text: 'Follow up', imageCount: 0, images: [] }, items: [] }],
      } as ThreadState)
      expect(sections[0]?.userMessage?.ts).toBeUndefined()
      expect(sections[0]?.startedAt).toBeUndefined()
      expect(sections[0]?.completedAt).toBeUndefined()
      expect(agentTranscriptSections('a1', [])[0]?.completedAt).toBeUndefined()
    })

    it('closes a completed turn with its own row, and leaves a live turn alone', () => {
      const keys = (section: TranscriptSection) => buildTranscriptRows([section], 'r1').map((r) => r.key)
      expect(keys(mainTranscriptSections(run({ task: '' }), {
        turns: [turn('turn-1', { startedAt: localIso(2026, 7, 31, 9), completedAt: localIso(2026, 7, 31, 9, 4) })],
      } as ThreadState)[0]!)).toEqual(['turn-1:turn-1-answer', 'turn-1:turn-time'])
      // Still running: no completion stamp, and therefore no placeholder row to jump later.
      expect(keys(mainTranscriptSections(run({ task: '' }), {
        turns: [turn('turn-1', { startedAt: localIso(2026, 7, 31, 9) })],
      } as ThreadState)[0]!)).toEqual(['turn-1:turn-1-answer'])
    })

    it('separates local days between turns, and only between them', () => {
      const rows = (turns: object[]) =>
        buildTranscriptRows(
          mainTranscriptSections(run({ task: '' }), { turns } as ThreadState),
          'r1',
        ).map((r) => r.key)

      // One day: no separator anywhere, not even above the first turn.
      expect(
        rows([
          turn('turn-1', { user: localIso(2026, 7, 31, 9) }),
          turn('turn-2', { user: localIso(2026, 7, 31, 17) }),
        ]).filter((key) => key.endsWith(':day-separator')),
      ).toEqual([])

      // Resumed the next morning: exactly one separator, and it opens the later turn.
      const multiDay = rows([
        turn('turn-1', { user: localIso(2026, 7, 31, 23) }),
        turn('turn-2', { user: localIso(2026, 8, 1, 9) }),
        turn('turn-3', { user: localIso(2026, 8, 1, 10) }),
      ])
      expect(multiDay.filter((key) => key.endsWith(':day-separator'))).toEqual(['turn-2:day-separator'])
      expect(multiDay.indexOf('turn-2:day-separator')).toBeLessThan(multiDay.indexOf('turn-2:user'))

      // Partly missing stamps never break the run of dates — the undated turn is just skipped.
      expect(
        rows([
          turn('turn-1', { user: localIso(2026, 7, 31, 9) }),
          turn('turn-2', {}),
          turn('turn-3', { user: localIso(2026, 7, 31, 18) }),
        ]).filter((key) => key.endsWith(':day-separator')),
      ).toEqual([])
    })

    /**
     * The stack renders directly under the task bubble but is queued LAST: a message stacked onto
     * a run that was continued days later is NEWER than the whole transcript beneath it. Letting
     * it move the day cursor put an "Aug 1" rule over July turns and, because the cursor only ever
     * advances, swallowed the genuine boundary inside the conversation — the one thing the
     * separator exists to show.
     */
    it('keeps a message stacked after the turns out of the day sequence', () => {
      const rows = buildTranscriptRows(
        mainTranscriptSections(
          run({
            createdAt: localIso(2026, 7, 30, 9),
            queuedMessages: [{ id: 'm1', text: 'Stacked later', createdAt: localIso(2026, 8, 1, 9) }],
          }),
          {
            turns: [
              turn('turn-1', { user: localIso(2026, 7, 30, 10) }),
              turn('turn-2', { user: localIso(2026, 7, 31, 10) }),
            ],
          } as ThreadState,
        ),
        'r1',
      ).map((r) => r.key)

      // It still renders where it always did, above the turns it will be sent after…
      expect(rows.indexOf('queued:m1')).toBeLessThan(rows.indexOf('turn-1:user'))
      // …with no rule above it claiming the July transcript below happened on Aug 1…
      expect(rows).not.toContain('queued:m1:day-separator')
      // …and the real Jul 30 → Jul 31 boundary between the turns intact.
      expect(rows.filter((key) => key.endsWith(':day-separator'))).toEqual(['turn-2:day-separator'])
    })

    it('draws the day rule as an announced separator through the real component tree', () => {
      render(
        <QueryClientProvider client={createQueryClient()}><SessionTranscript
          runId="r1"
          viewId="main"
          mode="document"
          sections={mainTranscriptSections(run({ task: '' }), {
            turns: [
              turn('turn-1', { user: localIso(2026, 7, 31, 23) }),
              turn('turn-2', { user: localIso(2026, 8, 1, 9) }),
            ],
          } as ThreadState)}
        /></QueryClientProvider>,
      )
      const separator = document.querySelector('[data-slot="day-separator"]')!
      expect(separator.getAttribute('role')).toBe('separator')
      // Assistive tech gets the same anchor a sighted reader has, not just the two decorative rules.
      expect(separator.getAttribute('aria-label')).toContain('2026')
      expect(separator.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-01')
    })

    it('renders the bubble time and the turn duration through the shared transcript', () => {
      const startedAt = localIso(2026, 7, 31, 14, 32)
      render(
        <QueryClientProvider client={createQueryClient()}><SessionTranscript
          runId="r1"
          viewId="main"
          mode="document"
          sections={mainTranscriptSections(run({ task: '' }), {
            turns: [
              turn('turn-1', {
                user: startedAt,
                startedAt,
                completedAt: new Date(new Date(startedAt).getTime() + 252_000).toISOString(),
              }),
            ],
          } as ThreadState)}
        /></QueryClientProvider>,
      )
      expect(document.querySelector('[data-slot="user-bubble"] [data-slot="message-time"]')).not.toBeNull()
      expect(document.querySelector('[data-slot="turn-time"]')?.textContent).toContain('· 4m 12s')
    })
  })

  it('groups the same normalized entries for an agent section', () => {
    const entries = [tool('read-1'), tool('read-2')]
    const rows = buildTranscriptRows(agentTranscriptSections('agent-1', entries), 'r1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('agent:agent-1:group:read-1')
    expect(rows[0]?.content).toMatchObject({ kind: 'block', block: { kind: 'context-group' } })
  })
})

describe('SessionTranscript', () => {
  const entries: ThreadEntry[] = [
    { kind: 'message', id: 'm1', role: 'assistant', text: 'Shared prose' },
    { kind: 'reasoning', id: 'r1', text: 'Shared reasoning' },
    tool('exec', {
      name: 'Bash',
      toolKind: 'execute',
      title: 'Ran npm test',
      output: 'all green',
      exitCode: 0,
    }),
    { kind: 'note', id: 'n1', text: 'Lifecycle note', tone: 'dim' },
    { kind: 'image', id: 'i1', url: '/shot.png', name: 'agent screenshot' },
  ]
  const sections: TranscriptSection[] = [{ id: 'shared', entries }]

  it.each(['document', 'panel'] as const)(
    'renders the canonical entry primitives in %s mode',
    (mode) => {
      render(
        <SessionTranscript runId="r1" viewId={mode} sections={sections} mode={mode} />,
      )
      expect(document.querySelector('[data-slot="assistant-message"]')?.textContent).toContain('Shared prose')
      expect(document.querySelectorAll('button[aria-label="Copy message"]')).toHaveLength(1)
      expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('Shared reasoning')
      expect(document.querySelector('[data-slot="tool-card"]')?.textContent).toContain('npm test')
      expect(document.querySelector('[data-slot="note-line"]')?.textContent).toContain('Lifecycle note')
      expect(document.querySelector('img[alt="agent screenshot"]')).not.toBeNull()
    },
  )

  it('updates a memoized entry block when its text changes', () => {
    const sections = (text: string): TranscriptSection[] => [{
      id: 'shared',
      entries: [{ kind: 'note', id: 'note-1', text, tone: 'dim' }],
    }]
    const { rerender } = render(
      <SessionTranscript
        runId="r1"
        viewId="memo-entry"
        sections={sections('Initial response')}
        mode="document"
        renderMode="flat"
      />,
    )

    expect(document.querySelector('[data-slot="note-line"]')?.textContent).toContain('Initial response')
    rerender(
      <SessionTranscript
        runId="r1"
        viewId="memo-entry"
        sections={sections('Updated response')}
        mode="document"
        renderMode="flat"
      />,
    )

    const note = document.querySelector('[data-slot="note-line"]')
    expect(note?.textContent).toContain('Updated response')
    expect(note?.textContent).not.toContain('Initial response')
  })

  it('renders the install action when it arrives on an existing danger note', () => {
    const client = createQueryClient()
    const transcript = (action?: 'install-skills') => {
      const events = asRunEvents([{ type: 'note', message: 'Shared skill unavailable', tone: 'danger', action }])
      return (
        <QueryClientProvider client={client}>
          <SessionTranscript
            runId="r1"
            viewId="memo-note-action"
            sections={mainTranscriptSections(run(), reduceThread(events))}
            mode="document"
            renderMode="flat"
          />
        </QueryClientProvider>
      )
    }

    const { rerender } = render(transcript())
    expect(screen.queryByRole('button', { name: 'Install skills' })).toBeNull()
    rerender(transcript('install-skills'))
    expect(screen.getByRole('button', { name: 'Install skills' }).closest('[data-slot="note-line"]')?.textContent)
      .toContain('Shared skill unavailable')
  })

  it('updates a memoized tool block when its live output and status change', () => {
    const sections = (status: UiToolItem['status'], output: string): TranscriptSection[] => [{
      id: 'shared',
      entries: [tool('exec', {
        name: 'Bash',
        toolKind: 'execute',
        title: 'Ran npm test',
        status,
        output,
      })],
    }]
    const { rerender } = render(
      <SessionTranscript
        runId="r1"
        viewId="memo-tool"
        sections={sections('running', 'partial output')}
        mode="document"
        renderMode="flat"
      />,
    )

    expect(document.querySelector('[data-slot="tool-card"]')?.getAttribute('data-status')).toBe('running')
    expect(document.querySelector('[data-slot="tool-output"]')?.textContent).toContain('partial output')
    rerender(
      <SessionTranscript
        runId="r1"
        viewId="memo-tool"
        sections={sections('running', 'complete output')}
        mode="document"
        renderMode="flat"
      />,
    )
    expect(document.querySelector('[data-slot="tool-output"]')?.textContent).toContain('complete output')
    expect(document.querySelector('[data-slot="tool-output"]')?.textContent).not.toContain('partial output')

    rerender(
      <SessionTranscript
        runId="r1"
        viewId="memo-tool"
        sections={sections('completed', 'complete output')}
        mode="document"
        renderMode="flat"
      />,
    )
    expect(document.querySelector('[data-slot="tool-card"]')?.getAttribute('data-status')).toBe('completed')
  })

  it('updates an ask block when the injected renderer changes', () => {
    const sections: TranscriptSection[] = [{
      id: 'shared',
      entries: [{
        kind: 'ask',
        id: 'ask-1',
        resolved: false,
        questions: [{
          id: 'q1',
          header: 'Choice',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Keep going' }],
        }],
      }],
    }]
    const { rerender } = render(
      <SessionTranscript
        runId="r1"
        viewId="memo-ask"
        sections={sections}
        mode="document"
        renderMode="flat"
        renderAsk={() => <span data-slot="custom-ask">First renderer</span>}
      />,
    )

    expect(document.querySelector('[data-slot="custom-ask"]')?.textContent).toBe('First renderer')
    rerender(
      <SessionTranscript
        runId="r1"
        viewId="memo-ask"
        sections={sections}
        mode="document"
        renderMode="flat"
        renderAsk={() => <span data-slot="custom-ask">Second renderer</span>}
      />,
    )

    expect(document.querySelector('[data-slot="custom-ask"]')?.textContent).toBe('Second renderer')
  })

  it('uses one recursive renderer for task-card children', () => {
    const parent = tool('task', {
      name: 'Task',
      toolKind: 'task',
      title: 'Task: audit auth',
    })
    const child = tool('child', {
      parentItemId: 'task',
      name: 'Bash',
      toolKind: 'execute',
      title: 'Ran npm test',
      output: 'passed',
    })
    render(
      <SessionTranscript
        runId="r1"
        viewId="agent:one"
        sections={[{ id: 'agent:one', entries: [parent, child] }]}
        mode="panel"
      />,
    )
    fireEvent.click(document.querySelector('[data-slot="tool-card"] button')!)
    expect(document.querySelector('[data-slot="tool-nested"]')?.textContent).toContain('npm test')
  })

  it('keeps canonical output, errors, diffs, and exit codes in the agent panel', () => {
    render(
      <SessionTranscript
        runId="r1"
        viewId="agent:details"
        sections={agentTranscriptSections('details', [
          tool('failed-command', {
            name: 'Bash',
            toolKind: 'execute',
            title: 'Ran npm test',
            status: 'failed',
            output: '1 test passed',
            error: '1 test failed',
            exitCode: 1,
            diffs: [{ path: 'src/session.ts', oldText: 'old\n', newText: 'new\n' }],
          }),
        ])}
        mode="panel"
      />,
    )
    const trigger = document.querySelector('[data-slot="tool-card"] button')!
    expect(trigger.textContent).toContain('1')
    fireEvent.click(trigger)
    const card = document.querySelector('[data-slot="tool-card"]')!
    expect(card.textContent).toContain('1 test passed')
    expect(card.textContent).toContain('1 test failed')
    expect(card.textContent).toContain('src/session.ts')
  })

  it('renders an attributed ask instead of silently dropping the entry', () => {
    render(
      <SessionTranscript
        runId="r1"
        viewId="agent:ask"
        sections={agentTranscriptSections('ask', [
          {
            kind: 'ask',
            id: 'ask-1',
            resolved: false,
            questions: [
              {
                id: 'q1',
                header: 'Choice',
                question: 'Continue?',
                options: [{ label: 'Yes', description: 'Keep going' }],
              },
            ],
          },
        ])}
        mode="panel"
      />,
    )
    expect(document.querySelector('[data-slot="ask-card"]')?.textContent).toContain(
      'Open the main session',
    )
  })

  it('leaves settled rows alone when a live frame only grows the last one', () => {
    const renderAsk = vi.fn(() => <p data-slot="test-ask">ask</p>)
    const sections = (tail: string): TranscriptSection[] => [{
      id: 'agent:memo',
      entries: [
        { kind: 'ask', id: 'ask-1', resolved: false, questions: [{ id: 'q1', header: 'Choice', question: 'Continue?', options: [{ label: 'Yes' }] }] },
        { kind: 'message', id: 'm1', role: 'assistant', text: tail },
      ],
    }]
    const view = render(
      <SessionTranscript runId="r1" viewId="memo" sections={sections('Wri')} mode="panel" renderAsk={renderAsk} />,
    )
    expect(renderAsk).toHaveBeenCalledTimes(1)

    view.rerender(
      <SessionTranscript runId="r1" viewId="memo" sections={sections('Writing')} mode="panel" renderAsk={renderAsk} />,
    )

    expect(renderAsk).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-slot="assistant-message"]')?.textContent).toContain('Writing')
  })

  it('provides a bounded, keyboard-scrollable panel with a stable scrollbar gutter', () => {
    render(<SessionTranscript runId="r1" viewId="agent:one" sections={sections} mode="panel" />)
    const viewport = document.querySelector('[data-slot="transcript-viewport"]')!
    expect(viewport.getAttribute('aria-label')).toBe('Agent transcript')
    expect(viewport.getAttribute('tabindex')).toBe('0')
    expect(viewport.className).toContain('overflow-y-auto')
    expect(viewport.className).toContain('[scrollbar-gutter:stable]')
  })

  it('switches a long agent transcript to the shared virtualized rows', () => {
    const longEntries = Array.from({ length: 301 }, (_, index): ThreadEntry => ({
      kind: 'message',
      id: `message-${index}`,
      role: 'assistant',
      text: `message ${index}`,
    }))
    render(
      <SessionTranscript
        runId="r1"
        viewId="agent:long"
        sections={agentTranscriptSections('long', longEntries)}
        mode="panel"
      />,
    )
    expect(document.querySelector('[data-slot="thread-rows"]')?.getAttribute('data-virtualized')).toBe('true')
  })

  it.each([
    ['Claude', claudeSubagent as object[], 'Scanning the auth middleware.'],
    ['OpenCode', opencodeSubtask as object[], 'Two callers: router.ts and session.ts.'],
  ])('renders %s attributed fixture output through the same component', (_backend, fixture, expected) => {
    const thread = reduceThread(asRunEvents(fixture))
    const selected = collectSubagents(thread.turns)[0]
    expect(selected).toBeDefined()
    render(
      <SessionTranscript
        runId="r1"
        viewId={`agent:${selected!.id}`}
        sections={agentTranscriptSections(selected!.id, subagentChildren(thread.turns, selected!.id))}
        mode="panel"
      />,
    )
    expect(document.querySelector('[data-slot="subagent-stream"]')?.textContent).toContain(expected)
  })

  it('keeps the Codex review fixture honest when it has no attributed children', () => {
    const thread = reduceThread(asRunEvents(codexReview as object[]))
    const selected = collectSubagents(thread.turns)[0]
    expect(selected).toBeDefined()
    const entries = subagentChildren(thread.turns, selected!.id)
    expect(entries).toEqual([])
    render(
      <SessionTranscript
        runId="r1"
        viewId={`agent:${selected!.id}`}
        sections={agentTranscriptSections(selected!.id, entries)}
        mode="panel"
        empty={<p data-slot="codex-empty">No attributed output</p>}
      />,
    )
    expect(document.querySelector('[data-slot="codex-empty"]')?.textContent).toBe('No attributed output')
  })
})

describe('quoting in the transcript', () => {
  const quoteSections: TranscriptSection[] = [{
    id: 'turn-seq-3',
    userMessageKey: 'turn-seq-3:user',
    userMessage: { text: 'Question' },
    entries: [
      tool('task', { name: 'Task', toolKind: 'task', title: 'Task: audit' }),
      { kind: 'message', id: 'sub', role: 'assistant', text: 'Sub-agent says hi', parentItemId: 'task' } as ThreadEntry,
      { kind: 'message', id: 'top', role: 'assistant', text: 'Top-level answer' },
    ],
  }]
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

  it('marks only the main transcript\'s top-level messages as quote bodies', () => {
    render(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={vi.fn()} />, { wrapper })
    fireEvent.click(document.querySelector('[data-slot="tool-card"] button')!)
    expect(document.querySelector('[data-slot="tool-nested"]')?.textContent).toContain('Sub-agent says hi')

    const bodies = [...document.querySelectorAll<HTMLElement>('[data-quote-body]')]
    expect(bodies.map((body) => body.textContent)).toEqual(['Question', 'Top-level answer'])
    expect(bodies.every((body) => body.dataset.quoteOwner === 'r1:main' && body.dataset.quoteRef === '3')).toBe(true)
  })

  it('gives the reply to the task ref 0 only once the oldest page is loaded', () => {
    const sections: TranscriptSection[] = [{ id: 'turn-fallback-1', entries: [{ kind: 'message', id: 'a1', role: 'assistant', text: 'First reply' }] }]
    const view = render(<SessionTranscript runId="r1" viewId="main" sections={sections} mode="document" onQuote={vi.fn()} />, { wrapper })
    expect(document.querySelector<HTMLElement>('[data-quote-body]')?.dataset.quoteRef).toBeUndefined()
    view.rerender(<SessionTranscript runId="r1" viewId="main" sections={sections} mode="document" onQuote={vi.fn()} firstTurnScope="turn-fallback-1" />)
    expect(document.querySelector<HTMLElement>('[data-quote-body]')?.dataset.quoteRef).toBe('0')
  })

  it('marks nothing in a sub-agent panel or a transcript that takes no quotes', () => {
    render(<SessionTranscript runId="r1" viewId="agent:x" sections={quoteSections} mode="panel" onQuote={vi.fn()} />, { wrapper })
    expect(document.querySelector('[data-quote-body]')).toBeNull()
    cleanup()
    render(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" />, { wrapper })
    expect(document.querySelector('[data-quote-body]')).toBeNull()
  })

  it('offers the toolbar only for a selection inside its own transcript', () => {
    const foreign = document.createElement('div')
    foreign.dataset.quoteOwner = 'manager'
    quoteMocks.capture = { source: foreign, excerpt: 'x', code: false, role: 'assistant' }
    const view = render(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={vi.fn()} />, { wrapper })
    expect(document.querySelector('[data-slot="quote-selection-toolbar"]')).toBeNull()

    quoteMocks.capture = { source: document.querySelector<HTMLElement>('[data-quote-body]')!, excerpt: 'x', code: false, role: 'user' }
    view.rerender(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={vi.fn()} />)
    expect(document.querySelector('[data-slot="quote-selection-toolbar"]')).not.toBeNull()
  })

  const quoteBody = () => document.querySelector<HTMLElement>('[data-quote-body]')!
  const placeBody = () => {
    const body = quoteBody()
    body.getBoundingClientRect = () => ({ top: 200, bottom: 220, left: 0, right: 100, width: 100, height: 20, x: 0, y: 200, toJSON: () => ({}) })
    return body
  }
  const touch = (coarse: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)', media: query, addEventListener: () => {}, removeEventListener: () => {},
  }))

  it('places the toolbar below the selection on touch, above it otherwise', () => {
    const onQuote = vi.fn()
    for (const [coarse, top] of [[false, '156px'], [true, '228px']] as const) {
      touch(coarse)
      const view = render(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={onQuote} />, { wrapper })
      quoteMocks.capture = { source: placeBody(), excerpt: 'x', code: false, role: 'user' }
      view.rerender(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={onQuote} />)
      expect(document.querySelector<HTMLElement>('[data-slot="quote-selection-toolbar"]')!.style.top).toBe(top)
      cleanup()
      quoteMocks.capture = null
    }
  })

  it('uses a host-owned capture and reports a dismissal', () => {
    const onQuoteDismiss = vi.fn()
    const view = render(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={vi.fn()} quoteCapture={null} />, { wrapper })
    // The host's capture wins over the transcript's own listener.
    quoteMocks.capture = { source: quoteBody(), excerpt: 'x', code: false, role: 'user' }
    view.rerender(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={vi.fn()} quoteCapture={null} />)
    expect(document.querySelector('[data-slot="quote-selection-toolbar"]')).toBeNull()

    const capture = { source: quoteBody(), excerpt: 'x', code: false, role: 'user' as const }
    view.rerender(<SessionTranscript runId="r1" viewId="main" sections={quoteSections} mode="document" onQuote={vi.fn()} quoteCapture={capture} onQuoteDismiss={onQuoteDismiss} />)
    expect(document.querySelector('[data-slot="quote-selection-toolbar"]')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onQuoteDismiss).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-slot="quote-selection-toolbar"]')).toBeNull()
  })

  it('does not re-bind the toolbar listeners on a streaming render', () => {
    const onQuote = vi.fn()
    const live = (tail: string): TranscriptSection[] => [{ ...quoteSections[0]!, entries: [...quoteSections[0]!.entries, { kind: 'message', id: 'tail', role: 'assistant', text: tail }] }]
    const view = render(<SessionTranscript runId="r1" viewId="main" sections={live('Wri')} mode="document" onQuote={onQuote} />, { wrapper })
    quoteMocks.capture = { source: quoteBody(), excerpt: 'x', code: false, role: 'user' }
    view.rerender(<SessionTranscript runId="r1" viewId="main" sections={live('Writ')} mode="document" onQuote={onQuote} />)
    expect(document.querySelector('[data-slot="quote-selection-toolbar"]')).not.toBeNull()
    const bind = vi.spyOn(window, 'addEventListener')
    view.rerender(<SessionTranscript runId="r1" viewId="main" sections={live('Writing')} mode="document" onQuote={onQuote} />)
    expect(bind.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)
    bind.mockRestore()
  })

  it('keeps settled rows when the caller passes a fresh onJump each render', () => {
    const renderAsk = vi.fn(() => <p>ask</p>)
    const live = (tail: string): TranscriptSection[] => [{
      id: 'turn-seq-1',
      entries: [
        { kind: 'ask', id: 'ask-1', resolved: false, questions: [{ id: 'q1', header: 'Choice', question: 'Continue?', options: [{ label: 'Yes' }] }] },
        { kind: 'message', id: 'm1', role: 'assistant', text: tail },
      ],
    }]
    const view = render(<SessionTranscript runId="r1" viewId="main" sections={live('Wri')} mode="document" renderAsk={renderAsk} onQuote={vi.fn()} onJump={() => {}} />, { wrapper })
    view.rerender(<SessionTranscript runId="r1" viewId="main" sections={live('Writing')} mode="document" renderAsk={renderAsk} onQuote={vi.fn()} onJump={() => {}} />)
    expect(renderAsk).toHaveBeenCalledTimes(1)
  })
})

describe('useQuoteJump', () => {
  const turn = (seq: number, messages: string[]): TranscriptSection => ({
    id: `turn-seq-${seq}`,
    userMessageKey: `turn-seq-${seq}:user`,
    userMessage: { text: `ask ${seq}` },
    entries: messages.map((text, index) => ({ kind: 'message', id: `m${index + 1}`, role: 'assistant', text })),
  })
  const scroller = (keys: readonly string[]) => {
    const box = document.createElement('div')
    for (const key of keys) {
      const row = document.createElement('div')
      row.dataset.slot = 'thread-row'
      row.dataset.rowKey = key
      row.innerHTML = '<div data-slot="assistant-message"></div>'
      box.append(row)
    }
    document.body.append(box)
    return box
  }

  it('pages back until the quoted turn is loaded, then lands on the matching message', async () => {
    const recent = buildTranscriptRows([turn(9, ['latest'])], 'r1')
    const all = buildTranscriptRows([turn(5, ['first reply', 'the second reply']), turn(9, ['latest'])], 'r1')
    const box = scroller(all.map((row) => row.key))
    const revealRow = vi.fn(() => true)
    let rows: TranscriptRowModel[] = recent
    const history = { hasOlder: true, loadOlder: vi.fn(async () => { rows = all; history.hasOlder = false; view.rerender() }) }
    const view = renderHook(() => useQuoteJump({ rows, history, scroll: { scrollElRef: { current: box }, revealRow } }))

    view.result.current({ id: 'q', role: 'assistant', ref: 5, rowKey: 'turn-seq-5', excerpt: 'second reply', code: false, body: '' })

    await waitFor(() => expect(revealRow).toHaveBeenCalledWith('turn-seq-5:m2', expect.any(Number)))
    expect(history.loadOlder).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(box.querySelector('[data-row-key="turn-seq-5:m2"] [data-slot="assistant-message"]')?.hasAttribute('data-jump-highlight')).toBe(true))
    expect(quoteMocks.toast).not.toHaveBeenCalled()
    box.remove()
  })

  it('toasts and does not scroll when the source is gone', async () => {
    const rows = buildTranscriptRows([turn(9, ['latest'])], 'r1')
    const revealRow = vi.fn(() => true)
    const { result } = renderHook(() => useQuoteJump({ rows, history: { hasOlder: false, loadOlder: vi.fn() }, scroll: { scrollElRef: { current: document.createElement('div') }, revealRow } }))

    result.current({ id: 'q', role: 'assistant', ref: 5, excerpt: 'gone', code: false, body: '' })

    await waitFor(() => expect(quoteMocks.toast).toHaveBeenCalledWith('That message is no longer in this transcript.', { tone: 'danger' }))
    expect(revealRow).not.toHaveBeenCalled()
  })

  it('does not take a mid-turn page (its user row as context) for the whole turn', async () => {
    // The newest page starts inside turn 5: its user row rides along, its first reply does not.
    const partial = buildTranscriptRows([turn(5, ['the later reply']), turn(9, ['latest'])], 'r1')
    const all = buildTranscriptRows([turn(3, ['older']), turn(5, ['the quoted reply', 'the later reply']), turn(9, ['latest'])], 'r1')
    const box = scroller(all.map((row) => row.key))
    const revealRow = vi.fn(() => true)
    let rows: TranscriptRowModel[] = partial
    const history = { hasOlder: true, loadOlder: vi.fn(async () => { rows = all; history.hasOlder = false; view.rerender() }) }
    const view = renderHook(() => useQuoteJump({ rows, history, scroll: { scrollElRef: { current: box }, revealRow } }))

    view.result.current({ id: 'q', role: 'assistant', ref: 5, excerpt: 'the quoted reply', code: false, body: '' })

    await waitFor(() => expect(revealRow).toHaveBeenCalledWith('turn-seq-5:m1', expect.any(Number)))
    expect(history.loadOlder).toHaveBeenCalledTimes(1)
    box.remove()
  })

  it('stops paging when a page adds nothing, and says the source is gone', async () => {
    const rows = buildTranscriptRows([turn(9, ['latest'])], 'r1')
    const revealRow = vi.fn(() => true)
    // hasOlder stays true and the page never adds rows: the old loop spun here for ever.
    const history = { hasOlder: true, loadOlder: vi.fn(async () => {}) }
    const { result } = renderHook(() => useQuoteJump({ rows, history, scroll: { scrollElRef: { current: document.createElement('div') }, revealRow } }))

    result.current({ id: 'q', role: 'assistant', ref: 5, excerpt: 'gone', code: false, body: '' })

    await waitFor(() => expect(quoteMocks.toast).toHaveBeenCalledWith('That message is no longer in this transcript.', { tone: 'danger' }), { timeout: 3000 })
    expect(history.loadOlder).toHaveBeenCalledTimes(1)
    expect(revealRow).not.toHaveBeenCalled()
  })
})

