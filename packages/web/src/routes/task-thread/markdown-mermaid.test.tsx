import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'

import { Markdown } from './markdown'

const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn(async (source: string) => {
    if (source.includes('invalid diagram')) throw new Error('Invalid Mermaid syntax')
    return { svg: '<svg class="pele"><text>Rendered diagram</text></svg>' }
  }),
}))

// Leave Streamdown real and stub only Pele's SVG renderer.
vi.mock('pele/lazy', () => ({ renderAsync: renderDiagram }))

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('light')
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { queueMicrotask(() => this.callback([{ isIntersecting: true }])) }
    takeRecords() { return [] }
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  renderDiagram.mockClear()
  vi.unstubAllGlobals()
})

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``

// The diagram renders behind a lazy import and a viewport timer; the 1s default fails under a full suite's load.
const SLOW = { timeout: 15_000 }

describe('Markdown Mermaid previews', { timeout: 40_000 }, () => {
  it('keeps the SVG when the cockpit theme changes; CSS supplies its palette', async () => {
    localStorage.setItem('cez-theme', 'light')
    render(
      <ThemeProvider>
        <ThemeToggle />
        <Markdown>{fence('flowchart LR\n  A --> B')}</Markdown>
      </ThemeProvider>,
    )
    await screen.findByRole('img', { name: 'Mermaid chart' }, SLOW)
    // The role can appear before the render call settles; a late call would leak into the next case.
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(1), SLOW)

    fireEvent.click(screen.getByRole('button', { name: 'Theme: light. Switch to dark.' }))
    expect(renderDiagram).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Theme: dark. Switch to system.' }))
    expect(renderDiagram).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Theme: system. Switch to light.' }))
    expect(renderDiagram).toHaveBeenCalledTimes(1)
  })

  it('renders Mermaid with source copying and keeps normal code fences', async () => {
    const flow = 'flowchart LR\n  A[Client] --> B[Gateway]'
    const { container } = render(<Markdown>{`${fence(flow)}\n\n\`\`\`text\nplain code\n\`\`\``}</Markdown>)

    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(1), SLOW)
    expect(renderDiagram.mock.calls.map(([source]) => source.trim())).toEqual([flow])
    expect(renderDiagram).toHaveBeenCalledWith(expect.any(String), { idPrefix: expect.any(String), links: false, images: false })
    expect(container.querySelectorAll('[data-streamdown="mermaid-block-actions"] [data-streamdown="code-block-copy-button"]')).toHaveLength(1)
    expect(container.querySelector('[data-language="text"]')?.textContent).toContain('plain code')
    expect(screen.queryByTitle('View fullscreen')).toBeNull()
    expect(screen.queryByTitle('Download diagram')).toBeNull()
  })

  it('keeps the source available on syntax errors and recovers when content changes', async () => {
    const { rerender } = render(<Markdown>{`Before.\n\n${fence('invalid diagram')}\n\nAfter.`}</Markdown>)
    await screen.findByText(/Invalid Mermaid syntax/, {}, SLOW)
    fireEvent.click(screen.getByText('Show Code'))
    expect(screen.getByText('invalid diagram')).toBeTruthy()
    expect(screen.getByText('After.')).toBeTruthy()

    rerender(<Markdown>{fence('flowchart LR\n  A --> B')}</Markdown>)
    await screen.findByRole('img', { name: 'Mermaid chart' }, SLOW)
    expect(screen.queryByText(/Invalid Mermaid syntax/)).toBeNull()
  })

  it('handles an incomplete streaming fence followed by a complete diagram', async () => {
    const { rerender } = render(<Markdown>{'```mermaid\nflowchart LR\n  A --> B'}</Markdown>)
    await screen.findByRole('img', { name: 'Mermaid chart' }, SLOW)
    rerender(<Markdown>{fence('flowchart LR\n  A --> B\n  B --> C')}</Markdown>)
    await waitFor(() => expect(renderDiagram.mock.calls.at(-1)?.[0]).toContain('B --> C'), SLOW)
  })

  it('keeps compact inline previews text-only', () => {
    const { container } = render(<Markdown inline>{fence('flowchart LR\n  A --> B')}</Markdown>)
    expect(container.querySelector('[data-streamdown="mermaid-block"], button, svg')).toBeNull()
    expect(container.textContent).toContain('A --> B')
    expect(renderDiagram).not.toHaveBeenCalled()
  })
})
