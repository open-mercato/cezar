import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  getRunTerminalCommands: vi.fn(async () => ({ commands: [] })),
  getRunTerminalUrls: vi.fn(async () => ({
    urls: [{ url: 'http://localhost:5177', lastSeenAt: '2026-10-20T10:00:00.000Z', running: true }],
  })),
}))

const { DetectedUrlsStrip } = await import('./terminal-extras')

afterEach(cleanup)

describe('DetectedUrlsStrip', () => {
  it('opens an address in the user\'s browser or in the Preview, each from its own control', async () => {
    const onOpen = vi.fn(() => true)
    render(<DetectedUrlsStrip runId="r1" onOpen={onOpen} />)

    // A new tab: the desktop shell hands `_blank` to the default browser.
    const external = await screen.findByRole('link', { name: 'Open http://localhost:5177 in Browser' })
    expect(external.getAttribute('href')).toBe('http://localhost:5177')
    expect(external.getAttribute('target')).toBe('_blank')
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open http://localhost:5177 in Preview' }))
    expect(onOpen).toHaveBeenCalledWith('http://localhost:5177')
  })
})
