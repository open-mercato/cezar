import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import type { AutomationEvent } from '@open-mercato/cezar-api-client'

import { DEFAULT_FILTERS, type DraftFilters } from './editor-draft'
import { EditorGithubFields } from './editor-github-fields'

afterEach(cleanup)

function Harness({ events: initial = ['issue.opened'] }: { events?: AutomationEvent[] }) {
  const [state, setState] = useState<{ events: AutomationEvent[]; intervalSeconds: number; filters: DraftFilters }>({
    events: initial,
    intervalSeconds: 300,
    filters: { ...DEFAULT_FILTERS },
  })
  return (
    <>
      <EditorGithubFields {...state} onChange={(patch) => setState((current) => ({ ...current, ...patch }))} />
      <output data-testid="events">{state.events.join(',')}</output>
    </>
  )
}

describe('EditorGithubFields', () => {
  it('offers the seven events as a multi-select, kept in contract order', () => {
    render(<Harness />)
    const chips = screen.getAllByRole('button', { pressed: true })
    // The chip reads in plain words; the event id stays its accessible name and its small print.
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual(['issue.opened'])
    expect(chips[0]?.textContent).toBe('An issue opensissue.opened')
    fireEvent.click(screen.getByRole('button', { name: 'pull_request.opened' }))
    expect(screen.getByTestId('events').textContent).toBe('pull_request.opened,issue.opened')
    fireEvent.click(screen.getByRole('button', { name: 'issue.opened' }))
    expect(screen.getByTestId('events').textContent).toBe('pull_request.opened')
    expect(screen.queryByRole('button', { name: 'release.published' })).toBeNull()
  })

  it('shows the poll line from the filters', () => {
    render(<Harness />)
    expect(screen.getByText('while this cockpit is open, looking back 7 days, at most 25 records.')).not.toBeNull()
  })

  it('flags changed labels as required for a label event and opens the filters', () => {
    render(<Harness events={['issue.labeled']} />)
    expect(screen.getByText('· changed labels required')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    const input = screen.getByLabelText('Changed labels (required)')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: 'bug' } })
    expect(screen.queryByText('· changed labels required')).toBeNull()
    fireEvent.change(screen.getByLabelText('Lookback days (1–90)'), { target: { value: '120' } })
    expect(screen.getByText('while this cockpit is open, looking back 90 days, at most 25 records.')).not.toBeNull()
  })
})
