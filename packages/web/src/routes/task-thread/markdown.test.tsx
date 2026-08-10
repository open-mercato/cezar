import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Markdown } from './markdown'

afterEach(cleanup)

/**
 * Streamdown + the Shiki singleton, rendered for real in jsdom (the JS regex engine needs no
 * browser API, so nothing is stubbed). What matters: a fence becomes a code block with the
 * copy button and language chip, tokens get their color from the `--syn-*` variables (the
 * dual-theme contract), and an unknown fence language degrades to plaintext instead of
 * crashing the message.
 */
describe('Markdown', () => {
  it('renders a ts fence as a code block with language chip and copy button, tokens on --syn-*', async () => {
    render(<Markdown>{'Before.\n\n```ts\nconst answer: number = 42;\n```'}</Markdown>)

    const block = document.querySelector('[data-streamdown="code-block"]')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('data-language')).toBe('ts')
    expect(document.querySelector('[data-streamdown="code-block-header"]')?.textContent).toBe('ts')
    expect(document.querySelector('[data-streamdown="code-block-copy-button"]')).not.toBeNull()
    // Download is deliberately off — a chat reply is not a file manager.
    expect(document.querySelector('[data-streamdown="code-block-download-button"]')).toBeNull()

    // The singleton loads shiki/core + the grammar lazily; the keyword token lands colored
    // with the CSS variable (never a hex literal — the theme IS the variables).
    await waitFor(
      () => {
        const spans = [...document.querySelectorAll('[data-streamdown="code-block-body"] span')]
        const colors = spans.map((s) => (s as HTMLElement).style.getPropertyValue('--sdm-c')).filter(Boolean)
        expect(colors).toContain('var(--syn-key)')
        expect(colors.some((c) => /#[0-9a-f]{3,8}/i.test(c))).toBe(false)
      },
      { timeout: 10_000 },
    )
  }, 15_000)

  it('renders an unknown fence language as plaintext — no crash, chip kept honest', async () => {
    render(<Markdown>{'```wat-lang\nsome opaque output\n```'}</Markdown>)
    const block = document.querySelector('[data-streamdown="code-block"]')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('data-language')).toBe('wat-lang')
    await waitFor(() => {
      expect(document.querySelector('[data-streamdown="code-block-body"]')?.textContent).toContain(
        'some opaque output',
      )
    })
  })

  it('renders streaming-typical markdown (emphasis, lists, inline code) as elements', () => {
    render(<Markdown>{'A **bold** claim with `code`.\n\n- one\n- two'}</Markdown>)
    expect(document.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold')
    expect(document.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('code')
    expect(document.querySelectorAll('[data-streamdown="list-item"]')).toHaveLength(2)
  })

  it('inline mode keeps formatting but unwraps links and block structure for compact previews', () => {
    const { container } = render(
      <Markdown inline>{'**bold** with `code` and [docs](https://example.com)\n\n- detail'}</Markdown>,
    )
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold')
    expect(container.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('code')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('p, ul, li')).toBeNull()
    expect(container.textContent).toContain('docs')
    expect(container.textContent).toContain('detail')
  })

  it('repairs an unterminated fence while streaming instead of leaking backticks', () => {
    render(<Markdown>{'Look:\n\n```ts\nconst part = "still stre'}</Markdown>)
    // The half-open fence renders as a code block (Streamdown's unterminated-block repair);
    // the raw ``` never shows as text.
    expect(document.querySelector('[data-streamdown="code-block"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('```')
  })

  // `breaks` — hard line breaks for human-typed text (#524).
  describe('breaks', () => {
    it('off by default: a single newline is CommonMark paragraph glue', () => {
      const { container } = render(<Markdown>{'line one\nline two'}</Markdown>)
      expect(container.querySelector('br')).toBeNull()
    })

    it('on: a single newline becomes a hard break, so a typed message keeps its shape', () => {
      const { container } = render(<Markdown breaks>{'line one\nline two'}</Markdown>)
      expect(container.querySelectorAll('br')).toHaveLength(1)
      expect(container.querySelectorAll('p')).toHaveLength(1)
    })

    it('on: blank lines still start a new paragraph', () => {
      const { container } = render(<Markdown breaks>{'one\n\ntwo'}</Markdown>)
      expect(container.querySelectorAll('p')).toHaveLength(2)
    })

    it('on: markdown still parses — the breaks plugin only splits text nodes', () => {
      render(<Markdown breaks>{'A **bold** claim\nand `code`.'}</Markdown>)
      expect(document.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold')
      expect(document.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('code')
    })

    it('on: GFM survives — remarkPlugins must EXTEND streamdown’s defaults, not replace them', () => {
      // Streamdown's `remarkPlugins` prop replaces its defaults, so a bare [remarkHardBreaks]
      // would silently drop remark-gfm: bare links would stop autolinking and tables/strike
      // would render as literal text — on the USER side only, which is the exact inconsistency
      // #524 set out to remove.
      const { container } = render(
        <Markdown breaks>{'see https://github.com/acme/demo/issues/142 and ~~gone~~'}</Markdown>,
      )
      expect(container.querySelector('[data-streamdown="link"]')).not.toBeNull()
      expect(container.querySelector('del')).not.toBeNull()
    })

    it('on: a trailing newline adds no dangling break', () => {
      const { container } = render(<Markdown breaks>{'ends in enter\n'}</Markdown>)
      expect(container.querySelector('br')).toBeNull()
    })

    it('on: CRLF is treated as one break, not two', () => {
      const { container } = render(<Markdown breaks>{'one\r\ntwo'}</Markdown>)
      expect(container.querySelectorAll('br')).toHaveLength(1)
    })

    it('sanitizes hostile markup rather than trusting it', () => {
      const { container } = render(
        <Markdown breaks>{'<script>pwn(1)</script>\n\n<img src=x onerror="pwn(2)">'}</Markdown>,
      )
      expect(container.querySelector('script')).toBeNull()
      expect(container.innerHTML).not.toContain('onerror')
    })

    it('never emits a javascript: href', () => {
      const { container } = render(<Markdown breaks>{'[x](javascript:pwn(1))'}</Markdown>)
      const hrefs = [...container.querySelectorAll('a, button')].map((el) => el.getAttribute('href'))
      expect(hrefs.some((href) => href?.startsWith('javascript:'))).toBe(false)
    })

    it('an unknown bare tag is dropped — the accepted cost of parsing user text as markdown', () => {
      // Pinned deliberately: rendering user messages as markdown (#524) means the sanitizer
      // strips unknown tags, so `Array<string>` loses its `<string>`. This matches the assistant
      // side and every markdown chat surface; it is a trade-off, not an oversight. If it ever
      // needs to change, escape bare `<` in USER text — do not disable sanitization.
      const { container } = render(<Markdown breaks>{'use Array<string> here'}</Markdown>)
      expect(container.textContent).toBe('use Array here')
    })

    it('on: a fenced block keeps its own newlines, blank lines and all', () => {
      render(<Markdown breaks>{'```js\na\n\nb\n```'}</Markdown>)
      const body = document.querySelector('[data-streamdown="code-block-body"]')
      expect(body?.querySelector('br')).toBeNull()
      expect(body?.textContent).toContain('a')
      expect(body?.textContent).toContain('b')
    })
  })

  /**
   * Link safety. Streamdown enables it by default and renders its own modal INLINE, next to the
   * link — a `fixed inset-0` box with no portal. Thread rows carry `content-visibility: auto`
   * (⇒ `contain: paint`), which makes the row the containing block and clip rect for exactly
   * such a box, so that modal rendered *inside the message* as an unreachable blurred rectangle.
   * These tests pin the fix: the confirm is ours, and it leaves the contained subtree.
   */
  describe('link safety', () => {
    const openMock = vi.fn()

    beforeEach(() => {
      vi.stubGlobal('open', openMock)
    })

    afterEach(() => {
      openMock.mockReset()
      vi.unstubAllGlobals()
    })

    /** Renders one link inside a paint-CONTAINED wrapper — the thread row, in miniature. */
    function renderLink(markdown = '[docs](https://example.com/a/very/long/path?q=1)') {
      return render(
        <div style={{ contentVisibility: 'auto' }} data-testid="contained-row">
          <Markdown>{markdown}</Markdown>
        </div>,
      )
    }

    it('confirms before following a link, in OUR dialog and not Streamdown’s inline one', () => {
      const { container } = renderLink()

      fireEvent.click(container.querySelector('[data-streamdown="link"]') as HTMLElement)

      expect(document.querySelector('[data-slot="link-safety-dialog"]')).not.toBeNull()
      expect(document.querySelector('[data-streamdown="link-safety-modal"]')).toBeNull()
      // Not followed yet — the whole point of the confirm.
      expect(openMock).not.toHaveBeenCalled()
    })

    it('portals the dialog OUT of the contained row — the regression this fix exists for', () => {
      const { container } = renderLink()
      const row = container.querySelector('[data-testid="contained-row"]') as HTMLElement

      fireEvent.click(container.querySelector('[data-streamdown="link"]') as HTMLElement)

      const dialog = document.querySelector('[data-slot="link-safety-dialog"]') as HTMLElement
      expect(dialog).not.toBeNull()
      // Inside the row it would resolve `position: fixed` against the row's paint-contained
      // box instead of the viewport, and be clipped to it.
      expect(row.contains(dialog)).toBe(false)
      expect(document.body.contains(dialog)).toBe(true)
    })

    it('shows the full destination address, untruncated', () => {
      const { container } = renderLink()

      fireEvent.click(container.querySelector('[data-streamdown="link"]') as HTMLElement)

      expect(document.querySelector('[data-slot="link-safety-url"]')?.textContent).toBe(
        'https://example.com/a/very/long/path?q=1',
      )
    })

    it('announces the address as part of the dialog’s description, not just visually', () => {
      // The address is the whole reason the prompt exists; announcing only the sentence would
      // leave a screen-reader user with exactly the question the dialog was opened to answer.
      const { container } = renderLink()

      fireEvent.click(container.querySelector('[data-streamdown="link"]') as HTMLElement)

      const dialog = document.querySelector('[data-slot="link-safety-dialog"]') as HTMLElement
      const describedBy = dialog.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(document.getElementById(describedBy as string)?.textContent).toContain(
        'https://example.com/a/very/long/path?q=1',
      )
    })

    it('opens the link in a new tab only once confirmed', () => {
      const { container } = renderLink()
      fireEvent.click(container.querySelector('[data-streamdown="link"]') as HTMLElement)

      fireEvent.click(screen.getByRole('button', { name: 'Open link' }))

      expect(openMock).toHaveBeenCalledWith(
        'https://example.com/a/very/long/path?q=1',
        '_blank',
        'noreferrer',
      )
    })

    it('cancelling closes the dialog and follows nothing', async () => {
      const { container } = renderLink()
      fireEvent.click(container.querySelector('[data-streamdown="link"]') as HTMLElement)

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitFor(() => {
        expect(document.querySelector('[data-slot="link-safety-dialog"]')).toBeNull()
      })
      expect(openMock).not.toHaveBeenCalled()
    })
  })
})
