import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, RunEvent, UiToolItem } from '@open-mercato/cezar-api-client'

import claudeSubagent from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import codexReview from '../../../../cezar/src/core/__fixtures__/codex/review-mode.expected.json'
import opencodeSubtask from '../../../../cezar/src/core/__fixtures__/opencode/subtask-nested.expected.json'

import {
  SessionTranscript,
  agentTranscriptSections,
  buildTranscriptRows,
  mainTranscriptSections,
  type TranscriptSection,
} from './session-transcript'
import { clearThreadScrollCaches } from './thread-scroll'
import { collectSubagents, subagentChildren } from './subagent-dock'
import { reduceThread, type ThreadEntry, type ThreadState } from './thread-state'

beforeEach(() => {
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
      expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('Shared reasoning')
      expect(document.querySelector('[data-slot="tool-card"]')?.textContent).toContain('npm test')
      expect(document.querySelector('[data-slot="note-line"]')?.textContent).toContain('Lifecycle note')
      expect(document.querySelector('img[alt="agent screenshot"]')).not.toBeNull()
    },
  )

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
