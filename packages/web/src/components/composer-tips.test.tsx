import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerTips } from './composer-tips'

/**
 * The composer tips card (spec 2026-10-26-first-run-onboarding § Composer tips) against a stand-in
 * composer: which tips a visit shows, how they are closed, and the quiet link that remains.
 */

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
})

function Harness({
  controls,
  seen,
  off,
  ready = true,
  loaded = true,
  onSeen = () => {},
  onOff = () => {},
}: {
  /** `data-slot`s of the pills on screen. */
  controls: string[]
  seen?: string[]
  off?: boolean
  ready?: boolean
  loaded?: boolean
  onSeen?: (id: string) => void
  onOff?: (off: boolean) => void
}) {
  const root = React.useRef<HTMLDivElement>(null)
  return (
    <div ref={root} className="relative">
      <div data-slot="composer">
        <textarea aria-label="Describe a task for the agent" />
        <button type="button" aria-label="Attach files" />
        {controls.map((slot) => (
          <button key={slot} type="button" data-slot={slot}>
            {slot}
          </button>
        ))}
      </div>
      <ComposerTips anchorRoot={root} ready={ready} loaded={loaded} seen={seen} off={off} onSeen={onSeen} onOff={onOff} />
    </div>
  )
}

const card = () => document.querySelector('[data-slot="composer-tip"]')
const tipId = () => card()?.getAttribute('data-tip')
const link = () => document.querySelector<HTMLButtonElement>('[data-slot="composer-tips-link"]')

describe('ComposerTips', () => {
  it('shows nothing before the pills and the ui-state are known', () => {
    const { rerender } = render(<Harness controls={['source-pill']} ready={false} />)
    expect(card()).toBeNull()
    rerender(<Harness controls={['source-pill']} loaded={false} />)
    expect(card()).toBeNull()
  })

  it('explains the first two controls on screen, one at a time, and rings the current one', () => {
    const onSeen = vi.fn()
    render(<Harness controls={['source-pill', 'worktree-toggle', 'autonomous-toggle']} onSeen={onSeen} />)

    expect(tipId()).toBe('slash-skills')
    expect(screen.getByText('Tip 1 of 2')).toBeTruthy()
    expect(screen.getByRole('note', { name: 'Tip: Type / for a skill' })).toBeTruthy()
    expect(document.querySelector('[data-slot="composer-tip-halo"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next tip' }))
    expect(onSeen).toHaveBeenCalledWith('slash-skills')
    expect(tipId()).toBe('source')
    expect(screen.getByText('Tip 2 of 2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(onSeen).toHaveBeenCalledWith('source')
    expect(card()).toBeNull()
    // More tips are left for the next visit, so the quiet link offers them, not a full replay.
    expect(link()?.textContent).toBe('Tips')
  })

  it('continues where the last visit stopped and skips controls that are not on screen', () => {
    render(<Harness controls={['source-pill', 'autonomous-toggle', 'model-pill']} seen={['slash-skills', 'source']} />)
    // No worktree toggle and no variants pill (no git): autonomous comes next, then the model.
    expect(tipId()).toBe('autonomous')
    fireEvent.click(screen.getByRole('button', { name: 'Next tip' }))
    expect(tipId()).toBe('model')
  })

  it('using the control it points at counts as got it', () => {
    const onSeen = vi.fn()
    render(<Harness controls={['source-pill', 'worktree-toggle']} seen={['slash-skills']} onSeen={onSeen} />)
    expect(tipId()).toBe('source')
    fireEvent.click(screen.getByRole('button', { name: 'source-pill' }))
    expect(onSeen).toHaveBeenCalledWith('source')
    expect(tipId()).toBe('worktree')
  })

  it('"Don’t show tips" turns them off for good and leaves the way back in', () => {
    const onOff = vi.fn()
    render(<Harness controls={['source-pill']} onOff={onOff} />)
    fireEvent.click(screen.getByRole('button', { name: 'Don’t show tips' }))
    expect(onOff).toHaveBeenCalledWith(true)
    expect(card()).toBeNull()
    expect(link()).not.toBeNull()
  })

  it('turned off: only the link, and it turns tips back on with a full walk-through', () => {
    const onOff = vi.fn()
    render(<Harness controls={['source-pill', 'worktree-toggle']} off onOff={onOff} />)
    expect(card()).toBeNull()
    expect(link()?.textContent).toBe('Show me around')
    fireEvent.click(link()!)
    expect(onOff).toHaveBeenCalledWith(false)
    expect(tipId()).toBe('slash-skills')
    expect(screen.getByText('Tip 1 of 4')).toBeTruthy()
  })

  it('once every tip on this screen was closed, "Show me around" replays them all', () => {
    render(<Harness controls={['source-pill']} seen={['slash-skills', 'source', 'attachments']} />)
    expect(card()).toBeNull()
    expect(link()?.textContent).toBe('Show me around')
    fireEvent.click(link()!)
    expect(screen.getByText('Tip 1 of 3')).toBeTruthy()
  })
})
