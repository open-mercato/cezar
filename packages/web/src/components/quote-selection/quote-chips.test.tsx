import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QuoteChips, tooltipText } from './quote-chips'

afterEach(cleanup)

const quote = { id: 'q1', role: 'assistant' as const, ref: 3, excerpt: 'A long answer', code: false, body: '' }

describe('QuoteChips', () => {
  it('edits the note inline, never through window.prompt', () => {
    const prompt = vi.spyOn(window, 'prompt')
    const onEdit = vi.fn()
    render(<QuoteChips quotes={[quote]} onEdit={onEdit} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit note on quote/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note on quote' }), { target: { value: 'Why?' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note on quote' }), { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledWith({ ...quote, body: 'Why?' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('Escape cancels the note without saving', () => {
    const onEdit = vi.fn()
    render(<QuoteChips quotes={[quote]} onEdit={onEdit} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit note on quote/ }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note on quote' }), { key: 'Escape' })
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('names each chip by its quote, so twelve Remove buttons are told apart', () => {
    render(<QuoteChips quotes={[quote, { ...quote, id: 'q2', excerpt: 'Another answer', body: 'Why?' }]} onEdit={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Remove quote: A long answer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove quote: Another answer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit note on quote: Another answer (has a note)' })).toBeTruthy()
  })

  it('keeps a typed note when focus leaves the editor for the composer', () => {
    const onEdit = vi.fn()
    render(<><QuoteChips quotes={[quote]} onEdit={onEdit} onRemove={vi.fn()} /><textarea aria-label="Composer" /></>)
    fireEvent.click(screen.getByRole('button', { name: /Edit note on quote/ }))
    const input = screen.getByRole('textbox', { name: 'Note on quote' })
    fireEvent.change(input, { target: { value: 'Why?' } })
    fireEvent.blur(input, { relatedTarget: screen.getByRole('textbox', { name: 'Composer' }) })
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith({ ...quote, body: 'Why?' })
    expect(screen.queryByRole('textbox', { name: 'Note on quote' })).toBeNull()
  })

  it('saves once on Enter and does not resave or undo an Escape on the following blur', () => {
    const onEdit = vi.fn()
    render(<QuoteChips quotes={[quote]} onEdit={onEdit} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit note on quote/ }))
    let input = screen.getByRole('textbox', { name: 'Note on quote' })
    fireEvent.change(input, { target: { value: 'Why?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onEdit).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Edit note on quote/ }))
    input = screen.getByRole('textbox', { name: 'Note on quote' })
    fireEvent.change(input, { target: { value: 'Discard me' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('shortens a long excerpt in the tooltip and shows all of it in the editor', () => {
    const long = 'word '.repeat(400).trim()
    expect(tooltipText('short')).toBe('short')
    expect(tooltipText(long).length).toBeLessThan(300)
    expect(tooltipText(long)).toMatch(/… \(click to read it all\)$/)
    render(<QuoteChips quotes={[{ ...quote, excerpt: long }]} onEdit={vi.fn()} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit note on quote/ }))
    expect(document.querySelector('[data-slot="quote-chip-excerpt"]')?.textContent).toBe(long)
  })

  it("uses the cockpit tooltip instead of the browser's title", async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    render(<QuoteChips quotes={[quote]} onEdit={vi.fn()} onRemove={vi.fn()} />)
    const chip = screen.getByRole('button', { name: /Edit note on quote/ })
    expect(chip.getAttribute('title')).toBeNull()

    fireEvent.focus(chip)
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('A long answer'))
    vi.unstubAllGlobals()
  })

  it('keeps a long quote tooltip within the viewport', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    render(<QuoteChips quotes={[{ ...quote, excerpt: 'A long answer '.repeat(200) }]} onEdit={vi.fn()} onRemove={vi.fn()} />)

    fireEvent.focus(screen.getByRole('button', { name: /Edit note on quote/ }))
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull())
    const tooltip = document.querySelector('[data-slot="tooltip-content"]') as HTMLElement
    expect(tooltip.className).toContain('max-h-[min(18rem,calc(100dvh-2rem))]')
    expect(tooltip.className).toContain('overflow-hidden')
    expect(tooltip.className).not.toContain('overflow-y-auto')
    vi.unstubAllGlobals()
  })

  it.each(['Enter', 'Escape'])('%s hands focus back to the chip, not to the page', (key) => {
    render(<QuoteChips quotes={[quote]} onEdit={vi.fn()} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit note on quote/ }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note on quote' }), { key })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Edit note on quote/ }))
  })
})
