import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The desktop Tasks table's foldable columns (#743), in a real browser (#822).
 *
 * What this proves that `task-columns.test.ts` and `use-task-table-columns.test.tsx` cannot: a
 * folded column is really NARROWER. Those suites run in jsdom, which does no layout at all — every
 * `getBoundingClientRect()` there is zero — so the only thing they can assert is that the
 * `data-folded` attribute and the `colgroup` width prop changed. Under `table-layout: auto` that
 * width is a *hint*: the browser is free to ignore it, and a fold that renders the attribute while
 * the column stays wide would pass every existing test. Measured width is the assertion that
 * closes that gap, and it needs a layout engine.
 *
 * Why this boots its OWN server instead of attaching to the shared test env, which is what the
 * issue's step 1 literally asks for — two reasons, both load-bearing:
 *
 *   1. The run store reads `.ai/cezar/runs.json` ONCE, at startup (`RunStore.open`), so the task
 *      rich enough to render every column (branch, diff stat, reference, directional usage, cost)
 *      can only be seeded BEFORE boot. Writing it under the running shared instance would change
 *      nothing — the same reason `quick-list.e2e.ts` boots its own.
 *   2. This suite READS AND MUTATES `ui-state.json`. `fixtureServeEnv` pins `CEZ_HOME` inside the
 *      throwaway `dataRoot`, which is a stronger form of the issue's "isolated CEZ_HOME" than the
 *      shared `.ai/qa/cez-home`: it cannot collide with `settings-appearance.e2e.ts`, which
 *      save/restores that very file, and it is removed with the `dataRoot` in `afterAll`.
 *
 * NOT covered here, deliberately: the issue's scenario point 6 (a queued run present while CPU and
 * Mem are folded). That case pins the defect in #821, fixed in parallel on #861, so the assertion
 * belongs with that fix rather than racing it.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-task-columns-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
/** Below the `md` breakpoint the table gives way to the card list. */
const MOBILE = { width: 390, height: 844 }

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

/**
 * A `RunRecord[]` — cezar's on-disk run index. One run, deliberately carrying something for EVERY
 * foldable column: without a value the cell renders an em dash, and a table of dashes would let a
 * fold that broke real content still pass.
 */
const FIXTURE = [
  {
    id: 'fold-columns-rich',
    title: 'add a structured changes endpoint plz',
    titleSummary: 'Structured changes endpoint for the git view',
    workflow: 'default',
    task: 'add a structured changes endpoint',
    status: 'review',
    createdAt: ago(40 * 60_000),
    startedAt: ago(39 * 60_000),
    finishedAt: ago(26 * 60_000),
    branch: 'cez/fold-columns-fixture',
    diffStat: { adds: 128, dels: 14, files: 6 },
    pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/743',
    tokensUsed: 128_400,
    inputTokens: 96_000,
    outputTokens: 32_400,
    costUsd: 1.23,
    archived: false,
    steps: [],
  },
]

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
  throw new Error(`cezar e2e: the task-columns fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let cezHome: string
let uiStateFile: string
let baseUrl: string
let bootProject: string

const TABLE = '[data-slot="tasks-table"]'
const th = (id: string) => `${TABLE} thead th[data-column-id="${id}"]`

type UiState = {
  appearance?: Record<string, unknown>
  taskTable?: { expandedColumns?: Record<string, boolean> }
} & Record<string, unknown>

function readUiState(): UiState | null {
  if (!existsSync(uiStateFile)) return null
  try {
    return JSON.parse(readFileSync(uiStateFile, 'utf8')) as UiState
  } catch {
    // A half-written file is a race, not a verdict — the caller polls.
    return null
  }
}

/** The write behind a toggle is fire-and-forget from the UI's point of view (a keepalive PUT), so
 *  poll the file until it lands rather than assume the click beat the assertion. */
async function waitForUiState(check: (state: UiState) => boolean, what: string): Promise<UiState> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = readUiState()
    if (state && check(state)) return state
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: ${uiStateFile} never showed ${what}`)
}

/**
 * A direct API write, retried past a reset keep-alive socket.
 *
 * Not defensive padding — this suite reliably hits it. Node's `fetch` pools connections and will
 * not retry a request it lost mid-flight, while the server is free to close an idle keep-alive
 * socket after a few seconds. Whole tests here go by driving only the BROWSER, so Node's pooled
 * socket sits untouched the entire time and the next direct call lands on a half-closed one:
 * `ECONNRESET`, which says nothing about the app. `getRun` in `queued-stack.e2e.ts` retries for
 * the same reason. Without this the spec passes only when the run finishes inside the keep-alive
 * window — which is exactly the sort of green that turns red in CI.
 */
async function putUiState(patch: Record<string, unknown>): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/workspace/ui-state`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error(`PUT /workspace/ui-state answered ${response.status}`)
      return
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw lastError
}

/** Open the Tasks overview and wait until the table is both rendered and interactive.
 *
 *  The `disabled` wait is not ceremony: the header toggles are disabled while the workspace
 *  ui-state query is still pending, precisely so a click cannot write a `taskTable` that has not
 *  yet learned its siblings. Clicking inside that window would test nothing and fail flakily. */
function openTasks(): void {
  browser.goto(`${baseUrl}/p/${bootProject}/`)
  browser.waitForFunction(`document.querySelector('${TABLE} thead th[data-column-id="workflow"] button') !== null`)
  browser.waitForFunction(`!document.querySelector('${TABLE} thead th[data-column-id="workflow"] button').disabled`)
}

/** The header's MEASURED width — the whole reason this spec needs a browser. */
function headerWidth(id: string): number {
  return Number(browser.evaluate(`document.querySelector('${th(id)}').getBoundingClientRect().width`))
}

/** Ids of the foldable headers currently rendered. Enumerated rather than hard-coded because the
 *  Tokens and Cost columns are capability-gated by the health response. */
function foldableHeaderIds(): string[] {
  return browser.evaluate(
    `[...document.querySelectorAll('${TABLE} thead th')].filter((el) => el.querySelector('button')).map((el) => el.dataset.columnId)`,
  ) as string[]
}

function foldedHeaderIds(): string[] {
  return browser.evaluate(
    `[...document.querySelectorAll('${TABLE} thead th[data-folded="true"]')].map((el) => el.dataset.columnId)`,
  ) as string[]
}

/** Drive the named columns to `folded`, clicking only the ones that are not there already.
 *
 *  Idempotent on purpose: a toggle blindly clicked into the state it already holds flips it the
 *  WRONG way, and the wait that follows then hangs for the full provider timeout — a 25-second
 *  failure that reads like a product hang and is really just an assumption about test order. */
function setFolded(ids: readonly string[], folded: boolean): void {
  for (const id of ids) {
    const isFolded = browser.count(`${th(id)}[data-folded="true"]`) === 1
    if (isFolded === folded) continue
    browser.click(`${th(id)} button`)
    browser.waitForFunction(
      `document.querySelector('${th(id)}[data-folded="true"]') ${folded ? '!==' : '==='} null`,
    )
  }
}

/** `textContent`, not the provider's `get text`: the latter returns *rendered* text, so the card's
 *  flex meta row comes back newline-separated and the comparison would be about whitespace. */
function cardText(): string {
  return String(
    browser.evaluate(`document.querySelector('[data-slot="task-card"]').textContent`),
  ).replace(/\s+/g, ' ').trim()
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-task-columns-'))
  mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(FIXTURE, null, 2), 'utf8')

  // Mirrors `fixtureServeEnv`, which pins CEZ_HOME here — change one, change the other.
  cezHome = resolve(dataRoot, '.cez-home')
  uiStateFile = join(cezHome, 'ui-state.json')

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
}, 90_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  // The whole workspace home lived inside dataRoot, so this is the ui-state cleanup too.
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('foldable Tasks-table columns against a live cezar (#822)', () => {
  it('ships with Branch folded, every other foldable column expanded, and no toggle in Status or Task', () => {
    openTasks()

    // The registry's one `defaultExpanded: false`, and nothing else.
    expect(browser.count(`${th('branch')}[data-folded="true"]`)).toBe(1)
    expect(foldedHeaderIds()).toEqual(['branch'])

    // Status and Task are structurally immutable — not merely defaulted to expanded. A user who
    // hand-edits `false` into either id must still get a header with nothing to press.
    expect(foldableHeaderIds()).not.toContain('status')
    expect(foldableHeaderIds()).not.toContain('task')
    expect(browser.count(`${th('status')} button`)).toBe(0)
    expect(browser.count(`${th('task')} button`)).toBe(0)
    // …and the ones that ARE foldable really do offer the affordance.
    expect(foldableHeaderIds()).toContain('workflow')
    expect(foldableHeaderIds()).toContain('branch')

    browser.screenshot(`${artifactsDir}/task-columns-defaults.png`)
  })

  it('folding Workflow measurably shrinks the column, not just its attribute', () => {
    const expandedWidth = headerWidth('workflow')

    browser.click(`${th('workflow')} button`)
    browser.waitForFunction(`document.querySelector('${th('workflow')}[data-folded="true"]') !== null`)

    expect(browser.count(`${th('workflow')} button[aria-pressed="false"]`)).toBe(1)

    // The claim the jsdom suites cannot make. The registry asks for 124px expanded and 42px
    // folded; assert a real, substantial shrink rather than an exact pixel count, which auto
    // table layout is entitled to adjust.
    const foldedWidth = headerWidth('workflow')
    expect(foldedWidth).toBeLessThan(expandedWidth)
    expect(expandedWidth - foldedWidth).toBeGreaterThan(20)

    browser.screenshot(`${artifactsDir}/task-columns-workflow-folded.png`)
  })

  it('persists the fold across a reload, and writes it into ui-state.json', async () => {
    const state = await waitForUiState(
      (s) => s.taskTable?.expandedColumns?.workflow === false,
      'taskTable.expandedColumns.workflow === false',
    )
    expect(state.taskTable?.expandedColumns?.workflow).toBe(false)

    // A cold load: the choice has to come back from the server, not from a live query cache.
    openTasks()
    expect(browser.count(`${th('workflow')}[data-folded="true"]`)).toBe(1)
    expect(browser.count(`${th('workflow')} button[aria-pressed="false"]`)).toBe(1)
    expect(foldedHeaderIds().sort()).toEqual(['branch', 'workflow'])
  })

  it('preserves an unrelated ui-state sibling when a column is toggled', async () => {
    // Write a preference this feature knows nothing about, through the same endpoint the app uses.
    await putUiState({ appearance: { accent: 'violet' } })
    await waitForUiState((s) => s.appearance?.accent === 'violet', 'appearance.accent === violet')

    // Reload so the client's cache holds the authoritative state including that sibling — the
    // controller composes its write from that cache, which is exactly where the regression lived.
    openTasks()
    browser.waitForFunction(`document.documentElement.dataset.accent === 'violet'`)

    browser.click(`${th('reference')} button`)
    browser.waitForFunction(`document.querySelector('${th('reference')}[data-folded="true"]') !== null`)

    const after = await waitForUiState(
      (s) => s.taskTable?.expandedColumns?.reference === false,
      'taskTable.expandedColumns.reference === false',
    )
    // Both keys coexist: the new choice landed AND the stranger survived. An earlier review pass
    // caught a shallow write that dropped it, which is why this is pinned at the browser level.
    expect(after.appearance?.accent).toBe('violet')
    expect(after.taskTable?.expandedColumns?.reference).toBe(false)
    expect(after.taskTable?.expandedColumns?.workflow).toBe(false)
  })

  it('renders the same card fields below md whatever the desktop fold choices are', () => {
    // Establish the folded desktop state explicitly rather than inheriting whatever the earlier
    // tests left — this assertion is about the card, so it must not also be a test of test order.
    const foldable = ['workflow', 'branch', 'reference'] as const
    openTasks()
    setFolded(foldable, true)

    browser.setViewport(MOBILE.width, MOBILE.height)
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="task-card"]') !== null`)

    const withFolds = cardText()
    // The card is the mobile presentation — the table is in the DOM but laid out away.
    expect(browser.count('[data-slot="task-card"]')).toBe(1)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('${TABLE}')).display`)).toBe('none')
    // Folding is a DESKTOP density choice; the card must still carry the run's real fields.
    expect(withFolds).toContain('cez/fold-columns-fixture')
    expect(withFolds).toContain('128')
    browser.screenshot(`${artifactsDir}/task-columns-mobile-cards.png`)

    // Expand everything on the desktop, then come back: the card must not have moved.
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    openTasks()
    setFolded(foldable, false)
    expect(foldedHeaderIds()).toEqual([])

    browser.setViewport(MOBILE.width, MOBILE.height)
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="task-card"]') !== null`)
    expect(cardText()).toBe(withFolds)
  })
})
