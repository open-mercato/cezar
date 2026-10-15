import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { IsolationBadge, IsolationMark, isolationStateOf } from './isolation-indicator'

afterEach(cleanup)

/**
 * The indicator reads the OUTCOME the engine recorded, never the request the
 * composer made. The two disagree exactly when it matters most — isolation was
 * asked for and not obtained — and a badge that reported the request would tell
 * someone their agent was contained when it ran on their machine.
 */
describe('isolation indicator', () => {
  it('distinguishes ran-isolated, fell-back, and nobody-asked', () => {
    expect(isolationStateOf({ isolation: { effective: true, container: 'cez-abc' } })).toBe('isolated')
    // A reason is what makes a fallback a fallback: isolation was wanted.
    expect(isolationStateOf({ isolation: { effective: false, reason: 'podman is not running' } })).toBe('fell-back')
    expect(isolationStateOf({ isolation: { effective: false } })).toBe('host')
    // A run from before this was recorded is not guessed at.
    expect(isolationStateOf({})).toBe('unknown')
  })

  it('says "not isolated" in a warning tone when the container was wanted and missed', () => {
    render(<IsolationBadge run={{ isolation: { effective: false, reason: 'podman machine is stopped' } }} />)
    const badge = document.querySelector('[data-slot="isolation-badge"]')
    expect(badge?.getAttribute('data-isolation')).toBe('fell-back')
    expect(badge?.textContent).toContain('not isolated')
    // The reason is on the element, because the run log's one-line note scrolls away.
    expect(badge?.getAttribute('title')).toContain('podman machine is stopped')
    expect(badge?.className).toContain('text-warning')
  })

  it('names the container it ran in', () => {
    render(<IsolationBadge run={{ isolation: { effective: true, container: 'cez-ab57117a' } }} />)
    const badge = document.querySelector('[data-slot="isolation-badge"]')
    expect(badge?.textContent).toContain('isolated')
    expect(badge?.getAttribute('title')).toContain('cez-ab57117a')
  })

  it('renders nothing at all for a run that predates the field', () => {
    // Not "host": nothing recorded the decision, and inventing one would make
    // every historical task claim it ran on this machine.
    render(<IsolationBadge run={{}} />)
    expect(document.querySelector('[data-slot="isolation-badge"]')).toBeNull()
  })

  it('marks only the rows worth marking — an ordinary host run gets nothing', () => {
    // A list row's pixels belong to the task's NAME; absence already means "on
    // this machine", and the task header says so in words.
    render(<IsolationMark run={{ isolation: { effective: false } }} />)
    expect(document.querySelector('[data-slot="isolation-mark"]')).toBeNull()

    cleanup()
    render(<IsolationMark run={{ isolation: { effective: true } }} />)
    expect(document.querySelector('[data-slot="isolation-mark"]')?.getAttribute('aria-label'))
      .toBe('Ran in a container')

    cleanup()
    render(<IsolationMark run={{ isolation: { effective: false, reason: 'no launcher' } }} />)
    expect(document.querySelector('[data-slot="isolation-mark"]')?.getAttribute('aria-label'))
      .toBe('Isolation requested but not used')
  })
})
