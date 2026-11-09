import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Markdown } from './markdown'

const { highlightSpy } = vi.hoisted(() => ({ highlightSpy: vi.fn() }))

vi.mock('@/lib/highlighter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/highlighter')>()
  return {
    ...actual,
    highlightSync: (...args: Parameters<typeof actual.highlightSync>) => {
      highlightSpy(args[0])
      return actual.highlightSync(...args)
    },
  }
})

vi.mock('pele/lazy', () => ({
  renderAsync: async () => ({ svg: '<svg class="pele"><text>Rendered diagram</text></svg>' }),
}))

beforeEach(() => {
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
  highlightSpy.mockClear()
  vi.unstubAllGlobals()
})

/** A reply exercising everything the transcript renders: fences (highlighted, unknown, plain,
 *  mermaid), lists, a table, links of every policy class, reference bubbles and CEZ markers. */
const REPRESENTATIVE = [
  '## Summary',
  '',
  'The **build** finished with `exit 0`; see [the log](https://example.com/log) and ~~old~~ *new* notes.',
  'A local [report](/tmp/report.md), a relative [file](./src/a.ts) and a [route](/p/project/tasks/1).',
  '',
  '- item one',
  '  - nested *item*',
  '- [ ] open task',
  '- [x] done task',
  '',
  '1. first',
  '2. second',
  '',
  '> a quoted line',
  '',
  '```ts',
  'const value: number = compute(42)',
  'console.log(value)',
  '```',
  '',
  '```wat-lang',
  'opaque output',
  '```',
  '',
  '```',
  'plain fence',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  A --> B',
  '```',
  '',
  '| a | b | c |',
  '|---|:-:|--:|',
  '| 1 | 2 | 3 |',
  '',
  'Task: [[task:proj/1234abcd-0000-0000-0000-000000000000]] and [[pr:12]]',
  '',
  '---',
  '',
  'https://example.com/autolink and <b>inline html</b>',
  '',
  'CEZ:PR=12',
  'CEZ:DONE',
].join('\n')

/**
 * innerHTML with attributes sorted and empty `style` dropped: an element React PATCHED (streaming)
 * and one it created (one-shot) differ in attribute insertion order only, which no reader sees.
 * React's useId counter is global, so ids are normalized too.
 */
function canonical(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (!(node instanceof Element)) return ''
  const attrs = [...node.attributes]
    .filter((a) => !(a.name === 'style' && a.value === ''))
    .map((a) => `${a.name}="${a.value}"`)
    .sort()
  const tag = node.tagName.toLowerCase()
  return `<${[tag, ...attrs].join(' ')}>${[...node.childNodes].map(canonical).join('')}</${tag}>`
}
const normalize = (html: string) => html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:/g, '«id»').replace(/mermaid-[\w-]+/g, 'mermaid-«id»').replace(/></g, '>\n<')

async function settled(container: HTMLElement) {
  await waitFor(() => {
    const colors = [...container.querySelectorAll('[data-streamdown="code-block-body"] span')]
      .map((s) => (s as HTMLElement).style.getPropertyValue('--sdm-c'))
    expect(colors).toContain('var(--syn-key)')
    expect(container.querySelector('svg.pele')).not.toBeNull()
  }, { timeout: 15_000 })
  return normalize([...container.childNodes].map(canonical).join(''))
}

describe('Markdown settled render', { timeout: 40_000 }, () => {
  it('pins the settled DOM of a representative reply', async () => {
    const { container } = render(<Markdown>{REPRESENTATIVE}</Markdown>)
    await expect(await settled(container)).toMatchFileSnapshot('__snapshots__/markdown-settled.html')
    // Byte for byte, too: a one-shot render has no patch artefacts to excuse.
    await expect(normalize(container.innerHTML)).toMatchFileSnapshot('__snapshots__/markdown-settled.raw.html')
  })

  it('ends a streamed reply in exactly the DOM of a one-shot render', async () => {
    const { container, rerender } = render(<Markdown>{''}</Markdown>)
    for (let at = 7; at < REPRESENTATIVE.length; at += 7) {
      await act(async () => rerender(<Markdown>{REPRESENTATIVE.slice(0, at)}</Markdown>))
    }
    await act(async () => rerender(<Markdown>{REPRESENTATIVE}</Markdown>))
    await expect(await settled(container)).toMatchFileSnapshot('__snapshots__/markdown-settled.html')
  })

  it('does not re-highlight closed code blocks when the reply grows', async () => {
    const fences = Array.from({ length: 4 }, (_, i) => `\`\`\`ts\nconst v${i} = ${i}\n\`\`\``).join('\n\n')
    const { container, rerender } = render(<Markdown>{`${fences}\n\nTail`}</Markdown>)
    await waitFor(() => expect(container.querySelectorAll('[data-streamdown="code-block-body"] span[style]').length).toBeGreaterThan(0), { timeout: 15_000 })
    highlightSpy.mockClear()
    for (const tail of [' grows', ' grows more', ' grows more still']) {
      await act(async () => rerender(<Markdown>{`${fences}\n\nTail${tail}`}</Markdown>))
    }
    expect(highlightSpy).not.toHaveBeenCalled()
  })
})
