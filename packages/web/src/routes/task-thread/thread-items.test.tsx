import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { RunEvent } from '@open-mercato/cezar-api-client'
import type { UiToolItem } from '@open-mercato/cezar-api-client'

import bashAndScreenshot from '../../../../cezar/src/core/__fixtures__/claude/bash-and-screenshot.expected.json'
import failedAndDenied from '../../../../cezar/src/core/__fixtures__/claude/failed-and-denied.expected.json'
import subagentTask from '../../../../cezar/src/core/__fixtures__/claude/subagent-task.expected.json'
import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import opencodeToolLifecycle from '../../../../cezar/src/core/__fixtures__/opencode/tool-lifecycle.expected.json'
import { groupThreadItems } from './thread-groups'
import {
  ContextGroup,
  isNearBottom,
  OUTPUT_CLAMP_LINES,
  ProviderAuthRequiredCard,
  ReasoningItem,
  ToolCard,
  ToolStreak,
} from './thread-items'
import { reduceThread } from './thread-state'
import { SessionTranscript } from './session-transcript'

afterEach(cleanup)

describe('ProviderAuthRequiredCard', () => {
  it.each([
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
  ] as const)('renders accessible fixed recovery guidance for %s', (provider, label) => {
    render(
      <MemoryRouter initialEntries={['/p/acme/tasks/r1']}>
        <ProviderAuthRequiredCard incident={{
          kind: 'provider-auth-required',
          id: 'v1:2',
          provider,
          authFailureId: 'incident-1',
        }} />
      </MemoryRouter>,
    )

    expect(screen.getByRole('alert').textContent).toContain(`This run needed ${label} authorization`)
    expect(screen.getByRole('alert').textContent).toContain(
      `Review ${label} settings before retrying.`,
    )
    expect(screen.getByRole('alert').textContent).not.toContain(`${label} needs authorization`)
    const link = screen.getByRole('link', { name: 'Open provider settings' })
    expect(link.getAttribute('href')).toBe('/p/acme/settings/agents#providers')
    expect(link.getAttribute('tabindex')).not.toBe('-1')
  })
})

/**
 * The tool cards, driven by REAL items: every fixture item below is pulled verbatim out of the
 * golden `.expected.json` mapper outputs (the exact v2 wire shapes the R2 mappers are pinned
 * to), never hand-invented.
 */

/** The `item` payload of a fixture's `item.*` event, by id + status. */
function goldenItem(events: object[], id: string, status: UiToolItem['status']): UiToolItem {
  for (const event of events as Array<{ item?: UiToolItem }>) {
    if (event.item?.kind === 'tool' && event.item.id === id && event.item.status === status) return event.item
  }
  throw new Error(`no golden tool item ${id} with status ${status}`)
}

const asRunEvents = (events: object[]): RunEvent[] =>
  events.map((event, index) => ({ seq: index + 1, ts: '2026-07-14T12:00:00.000Z', ...event }) as RunEvent)

const card = () => document.querySelector('[data-slot="tool-card"]')!
const trigger = (name: RegExp) => screen.getByRole('button', { name })

describe('ToolCard — states', () => {
  it('running without output: shimmering verb, spinner, locked (disabled trigger, no chevron)', () => {
    const item = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'running')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('running')
    const button = trigger(/Ran.*git status --short/)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.querySelector('.shimmer')?.textContent).toBe('Ran')
    expect(screen.getByRole('status', { name: 'Running' })).toBeTruthy()
    expect(document.querySelector('[data-slot="tool-output"]')).toBeNull()
  })

  it('completed execute: closed by default, expands to the mono output on click', () => {
    const item = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('completed')
    const button = trigger(/Ran.*git status --short/)
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(button.querySelector('.shimmer')).toBeNull()
    expect(screen.queryByText(/M src\/example\.ts/)).toBeNull() // closed by default
    fireEvent.click(button)
    expect(document.querySelector('[data-slot="tool-output"] pre')?.textContent).toBe(' M src/example.ts')
    fireEvent.click(button) // the user's toggle wins both ways
    expect(document.querySelector('[data-slot="tool-output"]')).toBeNull()
  })

  it('running execute WITH output: open by default — the live tail is visible while streaming', () => {
    const running = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'running')
    // What the reducer holds mid-stream: the running golden item + accumulated `item.delta{output}`.
    render(<ToolCard item={{ ...running, output: 'npm warn deprecated\n' }} />)
    expect(document.querySelector('[data-slot="tool-output"] pre')?.textContent).toContain('npm warn deprecated')
  })

  it('failed: closed by default with a faint tint; expands to the danger-toned error', () => {
    const item = goldenItem(failedAndDenied, 'toolu_fail_01', 'failed')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('failed')
    // A faint danger tint still identifies it, but the loud outline and auto-open are gone.
    expect(card().className).toContain('border-danger')
    expect(screen.getByText('failed')).toBeTruthy()
    // Calm by default: the red error body only appears once the reader opens the card.
    expect(document.querySelector('[data-slot="tool-error"]')).toBeNull()
    fireEvent.click(trigger(/failed/))
    const error = document.querySelector('[data-slot="tool-error"]')
    expect(error?.textContent).toContain('npm ERR! Missing script: "lint"')
    expect(error?.className).toContain('text-danger')
  })

  it('declined: labeled, and locked when the backend reported no detail', () => {
    const item = goldenItem(failedAndDenied, 'toolu_denied_01', 'declined')
    render(<ToolCard item={item} />)
    expect(card().getAttribute('data-status')).toBe('declined')
    expect(screen.getByText('declined')).toBeTruthy()
    expect((screen.getByRole('button', { name: /declined/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('edit with diffs: old/new render as a tinted unified block inside InlineDiffPreview', () => {
    const item = goldenItem(thinkingEditWriteTodo, 'toolu_01AB', 'completed')
    render(<ToolCard item={item} />)
    fireEvent.click(trigger(/Edit.*\/repo\/src\/middleware\.ts/))
    const preview = document.querySelector('[data-slot="diff-preview"]')!
    expect(preview.textContent).toContain('/repo/src/middleware.ts')
    expect(preview.textContent).toContain("- return redirect('/login')")
    expect(preview.textContent).toContain("+ return redirect('/login', { preserveSession: true })")
  })

  it('a new file (oldText null, the golden Write) renders only added lines', () => {
    const item = goldenItem(thinkingEditWriteTodo, 'toolu_01CD', 'completed')
    render(<ToolCard item={item} />)
    fireEvent.click(trigger(/Write.*\/repo\/src\/middleware\.test\.ts/))
    const preview = document.querySelector('[data-slot="diff-preview"]')!
    expect(preview.textContent).toContain("+ import { test } from 'vitest'")
    expect(preview.textContent).not.toContain('- ')
  })
})

describe('ToolCard — exit-code pill (execute kind)', () => {
  it('exit 0 (the golden opencode bash item) → success pill', () => {
    const item = goldenItem(opencodeToolLifecycle, 'prt_01J8ZE21TOOL', 'completed')
    expect(item.exitCode).toBe(0)
    render(<ToolCard item={item} />)
    const pill = document.querySelector('[data-slot="tool-exit"]')!
    expect(pill.textContent).toBe('0')
    expect(pill.className).toContain('text-success')
  })

  it('a non-zero exit → danger pill', () => {
    const item = goldenItem(opencodeToolLifecycle, 'prt_01J8ZE21TOOL', 'completed')
    render(<ToolCard item={{ ...item, exitCode: 2 }} />)
    const pill = document.querySelector('[data-slot="tool-exit"]')!
    expect(pill.textContent).toBe('2')
    expect(pill.className).toContain('text-danger')
  })

  it('no exit code reported (the golden claude Bash) → no pill invented', () => {
    render(<ToolCard item={goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')} />)
    expect(document.querySelector('[data-slot="tool-exit"]')).toBeNull()
  })
})

describe('ToolCard — long output clamps behind the fade and expands on demand', () => {
  const longOutput = Array.from({ length: OUTPUT_CLAMP_LINES + 8 }, (_, i) => `line ${i + 1}`).join('\n')
  const base = goldenItem(bashAndScreenshot, 'toolu_mock_1', 'completed')

  it('clamps, fades, and offers "Show all N lines"; expanding removes the clamp', () => {
    render(<ToolCard item={{ ...base, output: longOutput }} />)
    fireEvent.click(trigger(/Ran.*git status --short/))
    const output = () => document.querySelector('[data-slot="tool-output"]')!
    expect(output().getAttribute('data-clamped')).toBe('true')
    expect(document.querySelector('[data-slot="tool-output-fade"]')).toBeTruthy()

    const toggle = screen.getByRole('button', { name: `Show all ${OUTPUT_CLAMP_LINES + 8} lines` })
    fireEvent.click(toggle)
    expect(output().getAttribute('data-clamped')).toBeNull()
    expect(document.querySelector('[data-slot="tool-output-fade"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })

  it('short output renders whole — no fade, no toggle', () => {
    render(<ToolCard item={base} />)
    fireEvent.click(trigger(/Ran.*git status --short/))
    expect(document.querySelector('[data-slot="tool-output"]')?.getAttribute('data-clamped')).toBeNull()
    expect(document.querySelector('[data-slot="tool-output-fade"]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })
})

describe('isNearBottom — the live-tail stick rule', () => {
  it.each([
    [{ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, true], // empty box sticks
    [{ scrollTop: 780, scrollHeight: 1000, clientHeight: 216 }, true], // at the bottom
    [{ scrollTop: 770, scrollHeight: 1000, clientHeight: 216 }, true], // within the 24px grace
    [{ scrollTop: 400, scrollHeight: 1000, clientHeight: 216 }, false], // reader scrolled up
  ])('%o → %s', (box, expected) => {
    expect(isNearBottom(box)).toBe(expected)
  })
})

describe('ReasoningItem', () => {
  const text = 'The redirect drops the session cookie — the middleware needs to preserve it.'

  it('collapses to a dim "Thinking — {first line}" row; expands to the full text', () => {
    const twoLines = `Orienting on the project structure…\nThen I will read the README.`
    render(<ReasoningItem text={twoLines} />)
    const button = screen.getByRole('button', { name: /Thinking — Orienting on the project structure/ })
    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain('…')
    expect(screen.queryByText(/Then I will read the README/)).toBeNull()
    fireEvent.click(button)
    expect(screen.getByText(/Then I will read the README/)).toBeTruthy()
  })

  it('a single-line reasoning (the golden fixture text) shows whole with no ellipsis', () => {
    render(<ReasoningItem text={text} />)
    expect(screen.getByRole('button', { name: `Thinking — ${text}` })).toBeTruthy()
    expect(document.querySelector('[data-slot="reasoning"]')?.textContent).toContain(`Thinking — ${text}`)
  })

  it('renders Markdown in the compact preview and expanded reasoning without nested controls', () => {
    render(<ReasoningItem text={'**Assessing the lock** with `gh api`.\n\n- inspect owner\n- release safely'} />)

    const trigger = screen.getByRole('button', { name: /Thinking — Assessing the lock/ })
    const reasoning = document.querySelector('[data-slot="reasoning"]')!
    expect(reasoning.querySelector('[data-streamdown="strong"]')?.textContent).toBe('Assessing the lock')
    expect(trigger.querySelector('a, button')).toBeNull()
    expect(reasoning.textContent).not.toContain('**')

    fireEvent.click(trigger)
    expect(reasoning.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('gh api')
    expect(reasoning.querySelectorAll('[data-streamdown="list-item"]')).toHaveLength(2)
  })

  // #528 — an empty item must not leave a bare, un-expandable "Thinking —" row.
  it.each([['', 'empty'], ['   ', 'spaces'], ['\n\t ', 'whitespace']])(
    'renders nothing for %s text (%s)',
    (empty) => {
      const { container } = render(<ReasoningItem text={empty} />)
      expect(container.innerHTML).toBe('')
      expect(screen.queryByRole('button')).toBeNull()
    },
  )
})

describe('ContextGroup + ToolStreak', () => {
  it('the group row expands to the individual tool cards', () => {
    const read = goldenItem(subagentTask, 'toolu_sub_01', 'completed') // the golden Grep
    const blocks = groupThreadItems([read, { ...read, id: 'toolu_sub_02' }])
    const group = blocks[0]!
    if (group.kind !== 'context-group') throw new Error('expected a context group')
    render(<ContextGroup group={group} />)
    const button = screen.getByRole('button', { name: 'Explored 2 searches' })
    expect(document.querySelectorAll('[data-slot="tool-card"]')).toHaveLength(0)
    fireEvent.click(button)
    expect(document.querySelectorAll('[data-slot="tool-card"]')).toHaveLength(2)
  })

  it('the streak fold hides its children until toggled', () => {
    render(
      <ToolStreak count={4}>
        <div data-testid="older-card" />
      </ToolStreak>,
    )
    const button = screen.getByRole('button', { name: '4 earlier tool calls' })
    expect(screen.queryByTestId('older-card')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByTestId('older-card')).toBeTruthy()
  })
})

describe('sub-agent nesting (golden subagent-task fixture, end to end through the reducer)', () => {
  it("the Task card's body lists the nested items, indented one level", () => {
    const { turns } = reduceThread(asRunEvents(subagentTask))
    const blocks = groupThreadItems(turns[0]!.items)
    const task = blocks.find((b) => b.kind === 'tool-card')
    if (task?.kind !== 'tool-card') throw new Error('expected the Task card')
    render(
      <SessionTranscript
        runId="r1"
        viewId="main"
        sections={[{ id: 'turn-1', entries: turns[0]!.items }]}
        mode="document"
      />,
    )

    const button = screen.getByRole('button', { name: /Task/ })
    expect((button as HTMLButtonElement).disabled).toBe(false) // nested children ARE detail — the card is not locked
    fireEvent.click(button)
    const nested = document.querySelector('[data-slot="tool-nested"]')!
    expect(nested.querySelector('[data-slot="assistant-message"]')?.textContent).toContain('Scanning the auth middleware')
    expect(nested.querySelectorAll('[data-slot="tool-card"]')).toHaveLength(1)
  })
})
