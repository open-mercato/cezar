import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RunStatusAnnouncer } from './status-announcer'

afterEach(cleanup)

const region = () => document.querySelector('[data-slot="run-status-announcer"]')!

describe('RunStatusAnnouncer (audit B6)', () => {
  it('is a polite visually-hidden live region', () => {
    render(<RunStatusAnnouncer status="running" />)
    expect(region().getAttribute('aria-live')).toBe('polite')
    expect(region().getAttribute('role')).toBe('status')
    expect(region().className).toContain('sr-only')
  })

  it('stays silent on the initial state — opening a finished thread announces nothing', () => {
    render(<RunStatusAnnouncer status="done" />)
    expect(region().textContent).toBe('')
  })

  it('announces each transition, in words', () => {
    const view = render(<RunStatusAnnouncer status="running" />)
    view.rerender(<RunStatusAnnouncer status="waiting" />)
    expect(region().textContent).toBe('Agent is waiting for your reply')

    view.rerender(<RunStatusAnnouncer status="review" />)
    expect(region().textContent).toBe('Changes are ready for review')

    view.rerender(<RunStatusAnnouncer status="done" />)
    expect(region().textContent).toBe('Run finished')
  })

  it('a re-render with the SAME status does not re-announce', () => {
    const view = render(<RunStatusAnnouncer status="running" />)
    view.rerender(<RunStatusAnnouncer status="waiting" />)
    view.rerender(<RunStatusAnnouncer status="waiting" />)
    expect(region().textContent).toBe('Agent is waiting for your reply')
  })
})
