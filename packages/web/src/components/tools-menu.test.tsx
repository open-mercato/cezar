import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { AppShell } from './app-shell'
import { ThemeProvider } from './theme-provider'
import { ToolsMenu, forgeNote, toolsTooltip } from './tools-menu'

afterEach(cleanup)

beforeEach(() => {
  // jsdom ships neither matchMedia (the shell's breakpoint effect) nor ResizeObserver
  // (Radix positions the dropdown with floating-ui, which observes the trigger's size).
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

/** A `/api/v1/health` answer with both kinds of row: present tools with versions, and a missing
 *  one carrying the server's setup hint. The names/hints mirror `src/core/backend-detect.ts`. */
const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/cezar',
  repo: { root: '/home/me/cezar', branch: 'main' },
  defaultRunner: 'claude',
  checks: [
    { name: 'claude', available: true, version: '2.0.44', hint: 'if not authenticated, run `claude` once and log in' },
    { name: 'gh', available: true, version: '2.62.0' },
    { name: 'git', available: true, version: '2.43.0' },
    {
      name: 'codex',
      available: false,
      hint: 'optional: install the Codex CLI (npm i -g @openai/codex) and log in to use the Codex runner',
    },
  ],
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false },
}

const ALL_GOOD: HealthResponse = {
  ...HEALTH,
  checks: HEALTH.checks.filter((check) => check.available),
}

function renderMenu(health: HealthResponse | undefined) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ToolsMenu health={health} />
      <LocationProbe />
    </MemoryRouter>
  )
}

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

const trigger = () => screen.getByRole('button', { name: /Tools/ })
const triggerDot = () =>
  document.querySelector('[data-slot="tools-menu-trigger"] [data-slot="status-dot"]') as HTMLElement

/** Radix opens the menu on pointerdown, not click. */
async function openMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(trigger())
  return await screen.findByRole('menu')
}

const rowsIn = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('[data-slot="tool-row"]'))

describe('toolsTooltip', () => {
  it('is just the cezar version while everything is available', () => {
    expect(toolsTooltip(ALL_GOOD)).toBe('cezar v0.1.3')
  })

  it('names every tool needing attention', () => {
    const twoDown: HealthResponse = {
      ...HEALTH,
      checks: [...HEALTH.checks, { name: 'opencode', available: false, hint: 'optional: install OpenCode' }],
    }
    expect(toolsTooltip(twoDown)).toBe('cezar v0.1.3 · needs attention: codex, opencode')
  })
})

describe('ToolsMenu', () => {
  it('renders nothing while health is unknown — no invented tool list', () => {
    renderMenu(undefined)
    expect(document.querySelector('[data-slot="tools-menu-trigger"]')).toBeNull()
  })

  it('shows a green aggregate dot when every check is available', () => {
    renderMenu(ALL_GOOD)
    expect(triggerDot().getAttribute('data-tone')).toBe('success')
    expect(trigger().getAttribute('title')).toBe('cezar v0.1.3')
  })

  it('shows a pending aggregate dot and names the tool in the tooltip when one is missing', () => {
    renderMenu(HEALTH)
    expect(triggerDot().getAttribute('data-tone')).toBe('pending')
    expect(trigger().getAttribute('title')).toBe('cezar v0.1.3 · needs attention: codex')
  })

  it('lists exactly the checks the server sent, in order — nothing invented', async () => {
    renderMenu(HEALTH)
    const menu = await openMenu()

    expect(within(menu).getByText('Installed tools')).toBeTruthy()
    // Exactly the four probed tools: the mockup's illustrative `mcp` row must NOT appear.
    expect(rowsIn(menu).map((row) => row.dataset.tool)).toEqual(['claude', 'gh', 'git', 'codex'])
  })

  it('renders an available tool as dot + mono name + version, not a link', async () => {
    renderMenu(HEALTH)
    const menu = await openMenu()

    const row = rowsIn(menu).find((el) => el.dataset.tool === 'claude') as HTMLElement
    expect(row.dataset.available).toBe('true')
    expect(row.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('success')
    expect(row.querySelector('[data-slot="tool-version"]')?.textContent).toBe('2.0.44')
    // Nothing to set up on a working tool: no link, no hint line.
    expect(row.closest('a')).toBeNull()
    expect(row.querySelector('[data-slot="tool-setup"]')).toBeNull()
    expect(row.querySelector('[data-slot="tool-hint"]')).toBeNull()
  })

  it('renders a missing tool with the server hint verbatim and a Set up link', async () => {
    renderMenu(HEALTH)
    const menu = await openMenu()

    const row = rowsIn(menu).find((el) => el.dataset.tool === 'codex') as HTMLElement
    expect(row.dataset.available).toBe('false')
    expect(row.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('danger')
    expect(row.querySelector('[data-slot="tool-version"]')?.textContent).toBe('not found')
    // The degradation doctrine: the server's human-written hint, word for word.
    expect(row.querySelector('[data-slot="tool-hint"]')?.textContent).toBe(
      'optional: install the Codex CLI (npm i -g @openai/codex) and log in to use the Codex runner'
    )
    expect(row.querySelector('[data-slot="tool-setup"]')?.textContent).toBe('Set up →')
    // The whole row is the link into Settings → Agents.
    expect(row.closest('a')?.getAttribute('href') ?? row.getAttribute('href')).toBe('/settings/agents')
  })

  it('navigates to /settings/agents from the Set up row and closes the menu', async () => {
    renderMenu(HEALTH)
    const menu = await openMenu()

    fireEvent.click(rowsIn(menu).find((el) => el.dataset.tool === 'codex') as HTMLElement)

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/settings/agents')
  })

  it('offers the cog row into Settings → Agents, and closes on navigation', async () => {
    renderMenu(ALL_GOOD)
    const menu = await openMenu()

    const settings = within(menu).getByRole('menuitem', { name: /Tool settings/ })
    expect(settings.getAttribute('href')).toBe('/settings/agents')

    fireEvent.click(settings)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('/settings/agents')
  })
})

/** The env-chips popover is where the spec's degradation table says the missing-GitHub hint
 *  lives (R6 Step 1.1) — the note must explain the hidden tab, in the server's own words. */
describe('forgeNote', () => {
  it('is null while the forge works — nothing to explain', () => {
    expect(forgeNote({ ...HEALTH, forge: { kind: 'github', available: true } })).toBeNull()
  })

  it('a null forge explains the hidden tab as a missing GitHub remote', () => {
    expect(forgeNote(HEALTH)).toContain('No GitHub remote detected')
    expect(forgeNote(HEALTH)).toContain('GitHub tab is hidden')
  })

  it('an unavailable driver carries the server reason verbatim', () => {
    const note = forgeNote({
      ...HEALTH,
      forge: { kind: 'github', available: false, reason: 'gh not logged in' },
    })
    expect(note).toContain('gh not logged in')
    expect(note).toContain('GitHub tab is hidden')
  })

  it('renders in the open menu when the forge is absent, and not when it works', async () => {
    const { unmount } = renderMenu(HEALTH)
    let menu = await openMenu()
    expect(within(menu).getByText(/No GitHub remote detected/)).toBeTruthy()
    unmount()

    renderMenu({ ...HEALTH, forge: { kind: 'github', available: true } })
    menu = await openMenu()
    expect(menu.querySelector('[data-slot="forge-note"]')).toBeNull()
  })
})

describe('ToolsMenu in the app shell', () => {
  function renderShell() {
    return render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/']}>
          <AppShell toolsMenu={<ToolsMenu health={HEALTH} />}>
            <p>route content</p>
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>
    )
  }

  it('sits in the desktop sidebar footer', () => {
    renderShell()
    const footer = document.querySelector(
      '[data-slot="sidebar"] [data-slot="sidebar-footer"]'
    ) as HTMLElement
    expect(footer.querySelector('[data-slot="tools-menu-trigger"]')).not.toBeNull()
  })

  it('comes along into the mobile drawer — same component, both framings', async () => {
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))

    const drawer = await screen.findByRole('dialog', { name: 'Navigation' })
    expect(drawer.querySelector('[data-slot="tools-menu-trigger"]')).not.toBeNull()
  })
})
