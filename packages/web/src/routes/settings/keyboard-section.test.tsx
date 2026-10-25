import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { KeyboardSection } from './keyboard-section'

let stored: Record<string, unknown> = {}
let puts: unknown[] = []

beforeEach(() => {
  stored = {}
  puts = []
  vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/workspace/ui-state') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          puts.push(body)
          stored = { ...stored, ...body }
        }
        return new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderSection = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <KeyboardSection />
    </QueryClientProvider>,
  )

const chordOf = (id: string) =>
  document.querySelector<HTMLButtonElement>(`[data-command-id="${id}"] [data-slot="shortcut-chord"]`)!

describe('Settings → Keyboard', () => {
  it('lists the shipped defaults', async () => {
    renderSection()
    await waitFor(() => expect(chordOf('terminal-column').textContent).toBe('⌘/'))
    expect(chordOf('tab:1').textContent).toBe('⌘1')
  })

  it('records a chord, moving it off the command that held it, and resets', async () => {
    renderSection()
    await waitFor(() => expect(chordOf('pin').disabled).toBe(false))
    fireEvent.click(chordOf('pin'))
    expect(await screen.findByText(/Press keys/)).toBeTruthy()
    act(() => {
      fireEvent.keyDown(window, { code: 'Slash', key: '/', metaKey: true })
    })
    await waitFor(() => expect(puts.at(-1)).toEqual({ keybindings: { 'terminal-column': null, pin: 'Mod+/' } }))
    expect(chordOf('pin').textContent).toBe('⌘/')

    // Reset takes the default back from the command holding it.
    fireEvent.click(screen.getByRole('button', { name: /Reset Terminal in a column/ }))
    await waitFor(() => expect(puts.at(-1)).toEqual({ keybindings: {} }))
    expect(chordOf('terminal-column').textContent).toBe('⌘/')
  })

  it.each([
    ['a press elsewhere', () => fireEvent.pointerDown(document.body)],
    ['a bare Tab', () => fireEvent.keyDown(window, { code: 'Tab', key: 'Tab' })],
    ['the chord button losing focus', () => fireEvent.blur(chordOf('pin'))],
  ])('%s stops recording and gives the keyboard back', async (_name, leave) => {
    renderSection()
    await waitFor(() => expect(chordOf('pin').disabled).toBe(false))
    fireEvent.click(chordOf('pin'))
    expect(await screen.findByText(/Press keys/)).toBeTruthy()
    act(() => {
      leave()
    })
    await waitFor(() => expect(screen.queryByText(/Press keys/)).toBeNull())
    const typed = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', cancelable: true })
    act(() => {
      window.dispatchEvent(typed)
    })
    expect(typed.defaultPrevented).toBe(false)
    expect(puts).toEqual([])
  })

  it('a press on the recording row’s own button does not cancel before its click toggles', async () => {
    renderSection()
    await waitFor(() => expect(chordOf('pin').disabled).toBe(false))
    fireEvent.click(chordOf('pin'))
    fireEvent.pointerDown(chordOf('pin'))
    expect(screen.getByText(/Press keys/)).toBeTruthy()
  })

  it('prints the hint text for the platform', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Win32' })
    renderSection()
    expect(await screen.findByText(/Shift\+Enter on a row there/)).toBeTruthy()
    expect(screen.getByText(/Ctrl chords also/)).toBeTruthy()
  })

  it('refuses a reserved chord and saves nothing', async () => {
    renderSection()
    await waitFor(() => expect(chordOf('pin').disabled).toBe(false))
    fireEvent.click(chordOf('pin'))
    act(() => {
      fireEvent.keyDown(window, { code: 'KeyK', key: 'k', metaKey: true })
    })
    expect(await screen.findByText(/taken by the browser or cezar/)).toBeTruthy()
    expect(puts).toEqual([])
  })
})
