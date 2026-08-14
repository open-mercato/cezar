import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { UiToolItem } from '@open-mercato/cezar-api-client'

import { ToolCard } from './thread-items'
import { ThreadCardCache, clearOpenCardCache } from './thread-open-cards'

afterEach(() => {
  cleanup()
  clearOpenCardCache()
})

/**
 * The open-card cache end to end through the real ToolCard: leaving a thread and coming back
 * (unmount → remount) restores exactly the cards the user touched, per run id.
 */

const item = (over: Partial<UiToolItem> = {}): UiToolItem => ({
  kind: 'tool',
  id: 'toolu_1',
  name: 'Bash',
  toolKind: 'execute',
  title: 'Ran npm test',
  status: 'completed',
  output: 'ok',
  ...over,
})

const card = (runId: string, tool: UiToolItem = item()) => (
  <ThreadCardCache runId={runId}>
    <ToolCard item={tool} cacheKey={`turn-1:${tool.id}`} />
  </ThreadCardCache>
)

const state = () => document.querySelector('[data-slot="tool-card"]')!.getAttribute('data-state')
const trigger = () => document.querySelector('[data-slot="collapsible-trigger"]')!

describe('the per-run open-card cache', () => {
  it('a user-opened card comes back open after unmount/remount; an untouched one stays default', () => {
    const first = render(card('r1'))
    expect(state()).toBe('closed') // finished execute: default closed
    fireEvent.click(trigger())
    expect(state()).toBe('open')
    first.unmount()

    render(card('r1'))
    expect(state()).toBe('open') // the revisit restores the explicit open
  })

  it('a user-closed card beats a would-be default-open on revisit', () => {
    // A running execute WITH output opens itself by default (the live tail) — the one default-open
    // case left now that failures start closed.
    const streaming = item({ status: 'running', output: 'installing…' })
    const first = render(card('r1', streaming))
    expect(state()).toBe('open')
    fireEvent.click(trigger())
    expect(state()).toBe('closed')
    first.unmount()

    render(card('r1', streaming))
    expect(state()).toBe('closed')
  })

  it('runs do not share card memory', () => {
    const first = render(card('r1'))
    fireEvent.click(trigger())
    first.unmount()

    render(card('r2'))
    expect(state()).toBe('closed')
  })

  it('without a cacheKey (a card outside the thread) nothing is remembered', () => {
    const first = render(
      <ThreadCardCache runId="r1">
        <ToolCard item={item()} />
      </ThreadCardCache>,
    )
    fireEvent.click(trigger())
    expect(state()).toBe('open')
    first.unmount()

    render(card('r1'))
    expect(state()).toBe('closed')
  })
})
