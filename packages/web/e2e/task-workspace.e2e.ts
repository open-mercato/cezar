import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/thread-run.record.json'

/**
 * The task workspace's layout mechanics (spec `.ai/specs/2026-10-07-task-workspace.md` §5.2,
 * acceptance criteria §10), in a real browser.
 *
 * WHAT THIS PROVES THAT `task-workspace.test.tsx` CANNOT. That suite runs in jsdom, which does no
 * layout at all: every `getBoundingClientRect()` there is zero, so the only thing it can assert
 * about a split is that the state and the inline `width` percentages changed. Those percentages
 * are the INPUT to a flex row — a column that renders `width: 50%` while a `min-width`, an
 * overflowing child or a stale `flex` keeps it full-bleed would pass every existing test. The
 * assertions below measure the rendered boxes, which is the same gap-closing argument
 * `task-columns.e2e.ts` makes for the folded Tasks columns, and it needs a layout engine.
 *
 * It also pins the two behaviors that only a trusted pointer and a real focus ring can exercise:
 * dragging a divider (the resize runs on pointer capture, and `setPointerCapture` rejects a
 * pointer id the browser is not actually tracking, so a dispatched PointerEvent cannot test it)
 * and moving a FOCUSED divider with the arrow keys.
 *
 * Why its own server rather than the shared test env: the run store reads `.ai/cezar/runs.json`
 * once at startup (`RunStore.open`), so the task these columns show has to be seeded BEFORE boot —
 * the same reason `commit-list.e2e.ts` and `quick-list.e2e.ts` boot their own. `fixtureServeEnv`
 * also pins `CEZ_HOME` inside the throwaway `dataRoot`, which matters here because this spec
 * depends on BROWSER-LOCAL layout state: it must start from a clean slate and must not inherit
 * layouts another spec's origin left behind.
 *
 * NOT covered here, deliberately:
 *  - Shift+Arrow's larger step. `press` sends one key against whatever has focus; the modifier
 *    combination is pinned in `task-workspace.test.tsx`, where the step arithmetic is the point.
 *  - The terminal drawer and the Browser column. Both are host capabilities with their own
 *    milestones and their own server-side suites; a layout spec that booted a PTY would be
 *    testing something else.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-task-workspace-${process.pid}`

const RUN_ID = 'aaaaaaaa-9999-4888-8777-bbbbbbbbcccc'

const DESKTOP = { width: 1440, height: 900 }
/** Below the workspace's desktop breakpoint, where columns stop sitting side by side. */
const MOBILE = { width: 390, height: 844 }

/** Fractional-layout slack. Deliberately tiny: the regressions these measurements must still
 *  catch are "the split never happened" and "the drag moved nothing", both hundreds of pixels. */
const SUB_PIXEL = 2

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** Every cockpit link is project-scoped, and a flat URL redirects onto its scoped twin — so the
 *  URL assertions below have to name the scoped form or they compare against a redirect. */
const scoped = (path: string) => `/p/${bootProject}${path}`

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the task-workspace server never answered at ${url}`)
}

/** A worktree with one commit past `main`, so a Zmiany or Pliki column has something real to
 *  render rather than an error state that would make a width measurement meaningless. */
function buildWorktree(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'cezar e2e'])
  writeFileSync(join(dir, 'README.md'), 'base\n', 'utf8')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
  git(['checkout', '-q', '-b', `cez/${RUN_ID.slice(0, 8)}`])
  writeFileSync(join(dir, 'notes.md'), 'a line the agent added\n', 'utf8')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'autosave: notes'])
}

/** Every column's measured width, left to right. */
function columnWidths(): number[] {
  return JSON.parse(
    browser.evaluate(`JSON.stringify(
      [...document.querySelectorAll('[data-slot="workspace-column"]')]
        .map((el) => el.getBoundingClientRect().width),
    )`) as string,
  ) as number[]
}

/** The views each column shows, left to right — the order a reorder or a reload must preserve. */
function columnViews(): string[] {
  return JSON.parse(
    browser.evaluate(`JSON.stringify(
      [...document.querySelectorAll('[data-slot="workspace-column"]')].map((el) => el.dataset.view),
    )`) as string,
  ) as string[]
}

/** Add a column through the active column's menu, which is where the `+` lives (the confirmed
 *  simple-header decision folded it in there rather than onto the strip). */
function addColumn(fromView: string, view: string, label: string): void {
  browser.click(`[data-slot="workspace-column"][data-view="${fromView}"] [aria-label="Menu kolumny ${label}"]`)
  browser.waitForFunction(
    `document.querySelector('[role="menuitem"][data-view="${view}"][data-view-action="add"]') !== null`,
  )
  browser.click(`[role="menuitem"][data-view="${view}"][data-view-action="add"]`)
}

function openWorkspace(): void {
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
  browser.waitForFunction(`document.querySelector('[data-slot="layout-cards"]') !== null`)
  browser.waitForFunction(`document.querySelector('[data-slot="workspace-column"]') !== null`)
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-task-workspace-'))
  const worktree = join(dataRoot, '.ai/cezar/worktrees', RUN_ID)
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  buildWorktree(worktree)

  const run = {
    ...record,
    id: RUN_ID,
    title: 'A task opened as a workspace',
    titleSummary: 'Workspace layouts',
    task: 'Lay some columns out.',
    worktreePath: worktree,
    branch: `cez/${RUN_ID.slice(0, 8)}`,
    baseBranch: 'main',
    steps: [record.steps[0]],
    pullRequestUrl: undefined,
  }
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([run], null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
  openWorkspace()
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  // Cleanup races the dying server (see thread-scroll.e2e.ts) — litter, not a failure.
  try {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* the OS reaps it */
  }
})

describe('the task workspace’s saved layouts and resizable columns', () => {
  it('opens on one full-width Czat column, with the layout strip replacing the route tabs', () => {
    // The spec's §2 success criterion: the saved-layout cards REPLACE the Session/Changes/
    // Commits/Files strip — "do not show both strips". `run-tabs` is the header's slot for that
    // row and stays in the DOM; what must be gone are the four route LINKS it holds by default,
    // which is why this counts anchors rather than the container.
    expect(browser.count('[data-slot="run-tabs"] a')).toBe(0)
    expect(browser.count('[data-slot="run-tabs"] [data-slot="layout-cards"]')).toBe(1)
    expect(browser.count('[data-slot="layout-card"]')).toBe(1)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="layout-cards"] [aria-current="page"]').textContent`,
      ),
    ).toBe('Czat')

    expect(columnViews()).toEqual(['session'])
    // Full width: the one column really fills its row, and the familiar task header is still
    // above it (the spec's "the current task stays the task").
    const [only] = columnWidths()
    const row = Number(
      browser.evaluate(
        `document.querySelector('[data-slot="workspace-columns"]').getBoundingClientRect().width`,
      ),
    )
    expect(only).toBeGreaterThan(0)
    expect(Math.abs(only! - row)).toBeLessThanOrEqual(SUB_PIXEL)
    expect(browser.count('[data-slot="run-header"]')).toBe(1)
  })

  it('a second column splits the row in half, measured', () => {
    addColumn('session', 'changes', 'Czat')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="workspace-column"]').length === 2`,
    )
    expect(columnViews()).toEqual(['session', 'changes'])

    const widths = columnWidths()
    const total = widths.reduce((sum, width) => sum + width, 0)
    // Two columns start at half each (spec §5.2). Measured, not inferred from the style
    // attribute — this is the assertion jsdom cannot make.
    for (const width of widths) expect(Math.abs(width - total / 2)).toBeLessThanOrEqual(total * 0.02)
    // And the divider between them is a real, focusable separator reporting its position.
    expect(browser.count('[data-slot="column-divider"]')).toBe(1)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="column-divider"]').getAttribute('role')`),
    ).toBe('separator')
    expect(
      Number(
        browser.evaluate(
          `document.querySelector('[data-slot="column-divider"]').getAttribute('aria-valuenow')`,
        ),
      ),
    ).toBeGreaterThan(0)

    browser.screenshot(`${artifactsDir}/workspace-two-columns.png`)
  })

  it('dragging a divider widens one side and narrows the other', () => {
    const before = columnWidths()
    const box = JSON.parse(
      browser.evaluate(`(() => {
        const r = document.querySelector('[data-slot="column-divider"]').getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      })()`) as string,
    ) as { x: number; y: number }

    // A trusted pointer stream — the resize runs on pointer capture, which a synthetic event
    // cannot drive.
    browser.dragTo({ x: box.x, y: box.y }, { x: box.x + 200, y: box.y })
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="workspace-column"]')[0].getBoundingClientRect().width > ${
        before[0]! + 50
      }`,
    )

    const after = columnWidths()
    expect(after[0]!).toBeGreaterThan(before[0]! + 50)
    expect(after[1]!).toBeLessThan(before[1]! - 50)
    // The row is still fully divided — a drag moves the boundary, it does not leak width.
    const total = after.reduce((sum, width) => sum + width, 0)
    expect(Math.abs(total - before.reduce((sum, width) => sum + width, 0))).toBeLessThanOrEqual(
      SUB_PIXEL * 2,
    )
  })

  it('a focused divider moves with the arrow keys', () => {
    const before = columnWidths()
    browser.evaluate(`document.querySelector('[data-slot="column-divider"]').focus()`)
    expect(
      browser.evaluate(`document.activeElement.dataset.slot`),
    ).toBe('column-divider')

    browser.press('ArrowLeft')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="workspace-column"]')[0].getBoundingClientRect().width < ${before[0]!}`,
    )
    const after = columnWidths()
    // One small step, in the direction pressed — narrower on the left, wider on the right.
    expect(after[0]!).toBeLessThan(before[0]!)
    expect(after[1]!).toBeGreaterThan(before[1]!)
  })

  it('a third column divides the row in thirds and exhausts the limit', () => {
    addColumn('changes', 'commits', 'Zmiany')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="workspace-column"]').length === 3`,
    )
    expect(columnViews()).toEqual(['session', 'changes', 'commits'])

    const widths = columnWidths()
    const total = widths.reduce((sum, width) => sum + width, 0)
    // Adding a column divides the available width EQUALLY among the remaining columns (spec
    // §5.2) — which also means the drag and the arrow key above were reset, on purpose.
    for (const width of widths) expect(Math.abs(width - total / 3)).toBeLessThanOrEqual(total * 0.02)
    expect(browser.count('[data-slot="column-divider"]')).toBe(2)

    // At three columns there is no `+` left to offer (spec §5.2 — "disable `+`").
    browser.click('[data-slot="workspace-column"][data-view="commits"] [aria-label="Menu kolumny Commity"]')
    browser.waitForFunction(`document.querySelector('[role="menu"]') !== null`)
    expect(browser.count('[role="menuitem"][data-view-action="add"]')).toBe(0)
    browser.press('Escape')

    browser.screenshot(`${artifactsDir}/workspace-three-columns.png`)
  })

  it('reopening the task restores the active layout, its columns and their order', () => {
    // Browser-local per task and per host (spec §5.3). Leaving the task entirely and coming
    // back is the case the criterion names — not merely a re-render.
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="workspace-column"]') === null`)
    openWorkspace()
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="workspace-column"]').length === 3`,
    )
    expect(columnViews()).toEqual(['session', 'changes', 'commits'])
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="layout-cards"] [aria-current="page"]').textContent`,
      ),
    ).toBe('Czat')
  })

  it('closing a column divides the remaining width equally', () => {
    browser.click('[data-slot="workspace-column"][data-view="changes"] [aria-label="Zamknij kolumnę Zmiany"]')
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="workspace-column"]').length === 2`,
    )
    expect(columnViews()).toEqual(['session', 'commits'])

    const widths = columnWidths()
    const total = widths.reduce((sum, width) => sum + width, 0)
    for (const width of widths) expect(Math.abs(width - total / 2)).toBeLessThanOrEqual(total * 0.02)
  })

  it('a deep link opens its view as a new card and leaves the saved layout alone', () => {
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}/files`)}`)
    // Wait for the COLUMN, not for `[data-route="task-files"]`: `GitTabLoading` — the Suspense
    // fallback this deep link shows while the lazy chunk arrives — renders that same attribute,
    // so waiting on it returns while the workspace itself is still unmounted.
    browser.waitForFunction(
      `document.querySelector('[data-slot="workspace-column"][data-view="files"]') !== null`,
    )
    // A new one-column card, named for the view and active (spec §5.3) …
    expect(columnViews()).toEqual(['files'])
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="layout-cards"] [aria-current="page"]').textContent`,
      ),
    ).toBe('Pliki')
    // … beside the `Czat` layout it did NOT disturb.
    expect(browser.count('[data-slot="layout-card"]')).toBe(2)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/tasks/${RUN_ID}/files`)}`)
  })

  it('a narrow viewport shows one column at a time, switched by compact tabs', () => {
    browser.setViewport(MOBILE.width, MOBILE.height)
    browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
    browser.waitForFunction(`document.querySelector('[data-narrow]') !== null`)
    // The deep link above left `Pliki` active and that selection persisted, so come back to the
    // two-column `Czat` card — the first in the strip — to have something to switch between.
    browser.click('[data-slot="layout-card"]:nth-of-type(1) button[aria-current], [data-slot="layout-card"]:nth-of-type(1) button:not([aria-label])')
    browser.waitForFunction(
      `document.querySelector('[role="tablist"][aria-label="Kolumny układu"] button:nth-of-type(2)') !== null`,
    )

    // Several columns in the layout, exactly one of them rendered (spec §5.2 "Narrow screens").
    const tabs = browser.count('[role="tablist"][aria-label="Kolumny układu"] [role="tab"]')
    expect(tabs).toBe(2)
    expect(browser.count('[data-slot="workspace-column"]')).toBe(0)
    expect(browser.text('[data-narrow] [role="tablist"]')).toContain('Czat')

    // Switching tabs swaps which one is rendered, and the page never overflows sideways.
    browser.click('[role="tablist"][aria-label="Kolumny układu"] button:nth-of-type(2)')
    browser.waitForFunction(`document.querySelector('[data-route="task-commits"]') !== null`)
    expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

    browser.screenshot(`${artifactsDir}/workspace-mobile.png`)
    browser.setViewport(DESKTOP.width, DESKTOP.height)
  })
})
