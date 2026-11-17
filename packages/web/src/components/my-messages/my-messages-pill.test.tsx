import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MyMessage } from './my-messages'
import { MyMessagesPill } from './my-messages-pill'
import { highlightJumpTarget, type MyMessagesNav } from './use-my-messages-nav'

const today = new Date().toISOString()
const items: MyMessage[] = [
  { id: 'task', order: 0, ts: today, text: 'Add a retry with **backoff**', images: 0, files: 0 },
  { id: 'turn-seq-9:user', order: 9, ts: today, text: 'Here is the log\nit retries forever', images: 1, files: 0 },
  { id: 'turn-seq-20:user', order: 20, ts: today, text: 'Compare with these notes', images: 0, files: 2 },
]

function fakeNav(overrides: Partial<MyMessagesNav> = {}): MyMessagesNav {
  return {
    items,
    targets: { prev: items[0], onScreen: ['turn-seq-9:user'] },
    refresh: vi.fn(),
    prev: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    jumpTo: vi.fn(async (_id: string, beforeHighlight?: () => void) => { beforeHighlight?.() }),
    ...overrides,
  }
}

const hoverPointer = () =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MyMessagesPill', () => {
  it('keeps every row when a day label recurs (a queued message sits between same-day turns)', async () => {
    const earlier = '2020-01-02T10:00:00.000Z'
    const recurring: MyMessage[] = [
      { id: 'task', order: 0, ts: earlier, text: 'Opening task', images: 0, files: 0 },
      { id: 'queued:q1', order: 0.5, ts: today, text: 'Queued later', images: 0, files: 0, pending: 'queued' },
      { id: 'turn-seq-4:user', order: 4, ts: earlier, text: 'Same day as the task', images: 0, files: 0 },
    ]
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<MyMessagesPill nav={fakeNav({ items: recurring, targets: { onScreen: [] } })} onLatest={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    await screen.findByRole('dialog')
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('data-message-id'))).toEqual(['task', 'queued:q1', 'turn-seq-4:user'])
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/same key/)
    error.mockRestore()
  })

  it('steps with ▲ / ▼, disables a side with nowhere to go, and keeps Jump to latest', () => {
    const nav = fakeNav()
    const onLatest = vi.fn()
    render(<MyMessagesPill nav={nav} onLatest={onLatest} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous message of yours' }))
    expect(nav.prev).toHaveBeenCalledOnce()
    expect((screen.getByRole('button', { name: 'Next message of yours' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    expect(onLatest).toHaveBeenCalledOnce()
    // No numbers anywhere (design revision 3).
    expect(screen.getByRole('group', { name: 'Your messages' }).textContent).not.toMatch(/\d/)
  })

  it('a touch screen opens the list as a sheet; a tap jumps and closes it', async () => {
    const nav = fakeNav()
    render(<MyMessagesPill nav={nav} onLatest={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    const sheet = await screen.findByRole('dialog')
    expect(sheet.getAttribute('data-slot')).toBe('my-messages-sheet')
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Add a retry with backoff'),
      expect.stringContaining('Here is the log · it retries forever'),
      expect.stringContaining('Compare with these notes'),
    ])
    // The message on screen is marked; the attachments are counted, with labels.
    expect(options[1]!.getAttribute('aria-current')).toBe('true')
    expect(options[0]!.getAttribute('aria-current')).toBeNull()
    expect(screen.getByLabelText('1 image')).toBeTruthy()
    expect(screen.getByLabelText('2 files')).toBeTruthy()
    fireEvent.click(options[2]!)
    expect(nav.jumpTo).toHaveBeenCalledWith('turn-seq-20:user', expect.any(Function))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('with a pointer that hovers, a click pins a popover the keyboard drives', async () => {
    hoverPointer()
    const nav = fakeNav()
    render(<MyMessagesPill nav={nav} onLatest={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    fireEvent.click(trigger)
    const list = await screen.findByRole('listbox', { name: 'Your messages' })
    await waitFor(() => expect(document.activeElement).toBe(list))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    // Opens on the message on screen; ↑ moves to the one before; Enter jumps there.
    expect(document.getElementById(list.getAttribute('aria-activedescendant')!)?.textContent).toContain('Here is the log')
    fireEvent.keyDown(list, { key: 'ArrowUp' })
    expect(document.getElementById(list.getAttribute('aria-activedescendant')!)?.textContent).toContain('Add a retry')
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(nav.jumpTo).toHaveBeenCalledWith('task', expect.any(Function))
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  })

  it('Escape closes the list and hands focus back to its button', async () => {
    hoverPointer()
    render(<MyMessagesPill nav={fakeNav()} onLatest={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Your messages' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const list = await screen.findByRole('listbox')
    fireEvent.keyDown(list, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('a hover peeks without taking focus', async () => {
    vi.useFakeTimers()
    try {
      hoverPointer()
      render(<MyMessagesPill nav={fakeNav()} onLatest={() => {}} />)
      const trigger = screen.getByRole('button', { name: 'Your messages' })
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      await act(async () => { vi.advanceTimersByTime(200) })
      expect(screen.getByRole('listbox')).toBeTruthy()
      expect(document.activeElement).not.toBe(screen.getByRole('listbox'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('the view can keep the wording of the button the pill grew out of', () => {
    render(<MyMessagesPill nav={fakeNav()} onLatest={() => {}} latestLabel="Scroll to bottom" latestSlot="manager-scroll-bottom" />)
    expect(screen.getByRole('button', { name: 'Scroll to bottom' }).getAttribute('data-slot')).toBe('manager-scroll-bottom')
  })
})

describe('highlightJumpTarget', () => {
  it('focuses and rings the message until focus moves on', () => {
    render(<><p data-testid="bubble">hello</p><button type="button">elsewhere</button></>)
    const bubble = screen.getByTestId('bubble')
    highlightJumpTarget(bubble)
    expect(document.activeElement).toBe(bubble)
    expect(bubble.hasAttribute('data-jump-highlight')).toBe(true)
    screen.getByRole('button').focus()
    expect(bubble.hasAttribute('data-jump-highlight')).toBe(false)
  })
})
