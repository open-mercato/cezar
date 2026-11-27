import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({
  getRunTerminalCommands: vi.fn(async () => ({ commands: [] })),
  getRunTerminalUrls: vi.fn(async () => ({
    urls: [{ url: 'http://localhost:5177', lastSeenAt: '2026-10-20T10:00:00.000Z', running: true }],
  })),
}))

const { DetectedUrlsStrip, NewTerminalMenu } = await import('./terminal-extras')

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

describe('DetectedUrlsStrip probe dot', () => {
  it('a responding address wears the design system dot in the success tone', async () => {
    render(<DetectedUrlsStrip runId="r1" onOpen={() => true} />)
    await screen.findByRole('link', { name: 'Open http://localhost:5177 in Browser' })
    const dot = document.querySelector<HTMLElement>('[data-slot="detected-url"] [data-slot="status-dot"]')!
    expect(dot.dataset.tone).toBe('success')
    expect(dot.dataset.probe).toBe('running')
  })
})

describe('NewTerminalMenu (#1554, #1555)', () => {
  const open = () =>
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'More terminal options' }),
      new MouseEvent('pointerdown', { bubbles: true }),
    )

  it('puts "Empty terminal" first and the sections in labelled groups', async () => {
    const commands = vi.fn(async () => ({
      commands: [{ command: 'npm run dev', source: 'package.json' }],
      configured: [{ name: 'Tests', command: 'pnpm test', scope: 'project' as const }],
    }))
    const onNew = vi.fn()
    const onRun = vi.fn()
    render(<NewTerminalMenu scope={{ commands }} shells={['/bin/zsh', '/bin/bash']} onNew={onNew} onRun={onRun} />)
    open()

    const items = await screen.findAllByRole('menuitem')
    expect(items[0]!.textContent).toContain('Empty terminal')
    for (const label of ['Shell', 'From the repo config', 'Detected commands', 'Custom command']) {
      expect(await screen.findByText(label)).toBeTruthy()
    }

    fireEvent.click(await screen.findByText('/bin/bash'))
    expect(onNew).toHaveBeenCalledWith('/bin/bash')
  })

  it('runs a defined command by its command line and shows its name', async () => {
    const commands = vi.fn(async () => ({
      commands: [],
      configured: [{ name: 'Unit tests', command: 'pnpm test', scope: 'personal' as const }],
    }))
    const onRun = vi.fn()
    render(<NewTerminalMenu scope={{ commands }} shells={['/bin/zsh']} onNew={vi.fn()} onRun={onRun} />)
    open()

    fireEvent.click(await screen.findByText('Unit tests'))
    expect(onRun).toHaveBeenCalledWith('pnpm test')
  })

  it('keeps your commands apart from the repo config\'s, yours first', async () => {
    const commands = vi.fn(async () => ({
      commands: [],
      configured: [
        { name: 'Mine', command: 'make mine', scope: 'personal' as const },
        { name: 'Theirs', command: 'make theirs', scope: 'project' as const },
      ],
    }))
    const { container } = render(<NewTerminalMenu scope={{ commands }} shells={[]} onNew={vi.fn()} onRun={vi.fn()} />)
    open()
    await screen.findByText('Theirs')

    const doc = container.ownerDocument
    const groups = [...doc.querySelectorAll('[data-slot="configured-group"]')].map((node) => node.textContent)
    expect(groups).toEqual(['Your commands', 'From the repo config'])
    const scopes = [...doc.querySelectorAll('[data-slot="configured-command"]')].map((node) => [
      node.getAttribute('data-scope'),
      node.textContent,
    ])
    expect(scopes).toEqual([['personal', 'Minemake mine'], ['project', 'Theirsmake theirs']])
  })

  it('with nothing defined still offers the detected commands, and no defined-command section', async () => {
    const commands = vi.fn(async () => ({ commands: [{ command: 'make build', source: 'Makefile' }] }))
    render(<NewTerminalMenu scope={{ commands }} shells={[]} onNew={vi.fn()} onRun={vi.fn()} />)
    open()

    expect(await screen.findByText('make build')).toBeTruthy()
    expect(screen.queryByText('Your commands')).toBeNull()
    expect(screen.queryByText('From the repo config')).toBeNull()
    expect(screen.queryByText('Shell')).toBeNull()
  })

  it('opens an empty terminal from its first item', async () => {
    const onNew = vi.fn()
    render(<NewTerminalMenu scope={{ commands: async () => ({ commands: [] }) }} shells={[]} onNew={onNew} onRun={vi.fn()} />)
    open()
    fireEvent.click(await screen.findByText('Empty terminal'))
    expect(onNew).toHaveBeenCalledWith()
  })
})
