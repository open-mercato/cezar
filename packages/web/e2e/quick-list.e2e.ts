import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv } from './agent-browser'

/**
 * The task quick-list, in a real browser, against a real cezar serving real runs.
 *
 * Why this spec boots its own server instead of using the shared test env: the run store reads
 * `.ai/cezar/runs.json` **once, at startup** (`RunStore.open`) and is in-memory from then on, so
 * writing that file under the already-running instance would change nothing — the way the inbox
 * spec can, because todos are file-watched and re-broadcast. The list would just render the empty
 * state. And "whatever runs happen to be in the dev checkout" is not a fixture: it is whatever the
 * last person did.
 *
 * So: a throwaway data dir, a fixture `runs.json`, one `node dist/index.js serve --repo <tmp>`.
 * The fixture is not invented data — `runs.json` is cezar's documented state contract (a
 * `RunRecord[]`, the exact shape `GET /api/v1/runs` answers with and `src/runs/store.ts` parses with
 * zod). If a record here were wrong, the store would drop it and these assertions would fail.
 *
 * Deliberate limitation: the statuses below are all terminal (`review`/`done`/`failed`). A serve
 * boot *recovers* live runs — `manager.recover()` re-queues `queued`, settles `waiting`, resumes
 * `running` — so a fixture cannot hold those still, and the "Working" bucket is therefore not
 * covered here. It is covered by the jsdom tests, which drive the component directly.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const repoRoot = resolve(import.meta.dirname, '../../..')
const runId = `e2e-quick-list-${process.pid}`

const now = Date.now()
const ago = (ms: number) => new Date(now - ms).toISOString()

/** A `RunRecord[]` — cezar's on-disk run index. */
const FIXTURE = [
  {
    id: 'fix-review-pr',
    // The raw title is the user's prompt-ish phrasing; `titleSummary` is what the server derived
    // on turn-end (#389). Every surface must show the summary — the raw title appearing anywhere
    // is a regression these specs now catch.
    title: 'add a structured changes endpoint plz',
    titleSummary: 'Structured changes endpoint for the git view',
    workflow: 'default',
    task: 'add a structured changes endpoint',
    status: 'review',
    createdAt: ago(40 * 60_000),
    finishedAt: ago(26 * 60_000),
    tokensUsed: 128_400,
    diffStat: { adds: 128, dels: 14, files: 6 },
    pullRequestUrl: 'https://github.com/open-mercato/cezar/pull/396',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-var-a',
    title: 'Add skills autocomplete to composer (A)',
    workflow: 'default',
    task: 'add skills autocomplete',
    status: 'review',
    createdAt: ago(30 * 60_000),
    finishedAt: ago(12 * 60_000),
    tokensUsed: 96_249,
    runner: 'claude',
    groupId: 'fix-group-1',
    variant: 'A',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-var-b',
    title: 'Add skills autocomplete to composer (B)',
    workflow: 'default',
    task: 'add skills autocomplete',
    status: 'review',
    createdAt: ago(30 * 60_000),
    finishedAt: ago(11 * 60_000),
    tokensUsed: 41_800,
    runner: 'codex',
    groupId: 'fix-group-1',
    variant: 'B',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-done',
    title: 'README parallel-agents tagline',
    workflow: 'default',
    task: 'update the readme',
    status: 'done',
    createdAt: ago(3 * 3_600_000),
    finishedAt: ago(2 * 3_600_000),
    tokensUsed: 12_000,
    diffStat: { adds: 9, dels: 2, files: 1 },
    archived: false,
    steps: [],
  },
  {
    id: 'fix-failed',
    title: 'Bump zod to v4',
    workflow: 'default',
    task: 'bump zod',
    status: 'failed',
    createdAt: ago(4 * 3_600_000),
    finishedAt: ago(3 * 3_600_000),
    tokensUsed: 4_100,
    error: 'checks failed',
    archived: false,
    steps: [],
  },
  {
    id: 'fix-archived',
    title: 'Sync merged PR issues',
    workflow: 'default',
    task: 'sync issues',
    status: 'done',
    createdAt: ago(30 * 3_600_000),
    finishedAt: ago(29 * 3_600_000),
    tokensUsed: 8_000,
    archived: true,
    archivedAt: ago(28 * 3_600_000),
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
  throw new Error(`cezar e2e: the fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const ROW = '[data-slot="task-row"]'
const TILE = '[data-slot="group-tile"]'

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2).
 *  Every in-app link the cockpit renders is scoped, so every href assertion below is too. */
const scoped = (path: string) => `/p/${bootProject}${path}`

/** An element's `textContent`, not the provider's `get text` — that returns *rendered* text, so a
 *  flex row comes back newline-separated and every assertion here would be about whitespace. */
const textOf = (selector: string) =>
  browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`) as string

/** The rendered rows/tiles under one bucket header, in DOM order. */
const rowsIn = (label: string) =>
  browser.evaluate(`(() => {
    const bucket = document.querySelector('[data-bucket=${JSON.stringify(label)}]')
    if (!bucket) return null
    return [...bucket.querySelectorAll('${ROW}, ${TILE}')].map((el) => el.textContent.trim())
  })()`) as string[] | null

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-'))
  mkdirSync(join(dataRoot, '.ai/cezar'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(FIXTURE, null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [join(repoRoot, 'dist/index.js'), 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    // Dry-run + a pinned CEZ_HOME, exactly as the shared test env does — see `fixtureServeEnv`.
    // Nothing in this spec starts a run, but the boot probes the backends.
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(runId)
  browser.setViewport(1440, 900)
}, 90_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('task quick-list', () => {
  beforeAll(() => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    // The list is async — it renders once `/api/v1/runs` answers.
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list"]') !== null`)
  })

  it('serves the fixture through the real API', async () => {
    // The store parsed and kept every record: if the shape were wrong, zod would have dropped the
    // index and the sidebar below would be asserting against an empty list that "passes" nothing.
    const runs = (await fetch(`${baseUrl}/api/v1/runs`).then((r) => r.json())) as Array<{ id: string }>
    expect(runs.map((r) => r.id).sort()).toEqual(
      ['fix-archived', 'fix-done', 'fix-failed', 'fix-review-pr', 'fix-var-a', 'fix-var-b'].sort()
    )
  })

  it('groups the runs under Needs you / Recent, in that order', () => {
    expect(
      browser.evaluate(`[...document.querySelectorAll('[data-slot="quick-list-bucket"] h2')].map((h) => h.textContent)`)
    ).toEqual(['Needs you', 'Recent'])

    // The review runs are what wants you; the terminal ones are history. The variant pair is one
    // tile, not two rows — so "Needs you" holds two things, not three.
    // Both are `review`, so the tie breaks on recency: the variant group started 30 minutes ago,
    // the PR review 40 — newest first. The PR row reads title (the auto-SUMMARY, not the raw
    // fixture title), then its `+128 −14` diff pair, then the PR chip.
    expect(rowsIn('Needs you')).toEqual([
      'Add skills autocomplete to composer×2',
      'Structured changes endpoint for the git view+128 −14PR',
    ])
    // fix-done recorded a diff on its last turn; fix-failed predates diffStat and shows none.
    expect(rowsIn('Recent')).toEqual(['README parallel-agents tagline+9 −22h', 'Bump zod to v43h'])
  })

  it('renders the diff pair through the success/danger tokens, not as plain text', () => {
    const pair = browser.evaluate(`(() => {
      const el = document.querySelector('[data-slot="task-row"][data-run-id="fix-review-pr"] [data-slot="diff-stat"]')
      if (!el) return null
      const [adds, dels] = el.querySelectorAll('span')
      return {
        adds: adds.textContent, dels: dels.textContent,
        // Resolved by the real CSS: green ≠ red proves the two tokens actually applied.
        addsColor: getComputedStyle(adds).color, delsColor: getComputedStyle(dels).color,
      }
    })()`) as { adds: string; dels: string; addsColor: string; delsColor: string } | null

    expect(pair?.adds).toBe('+128')
    expect(pair?.dels).toBe('−14')
    expect(pair?.addsColor).not.toBe(pair?.delsColor)
  })

  it('paints one dot per row, in the tone deriveAttention picked', () => {
    const tones = browser.evaluate(`(() => {
      const of = (id) => {
        const dot = document.querySelector('[data-run-id="' + id + '"] [data-slot="status-dot"]')
        return dot && { tone: dot.dataset.tone, pulses: getComputedStyle(dot).animationName !== 'none' }
      }
      return { review: of('fix-review-pr'), done: of('fix-done'), failed: of('fix-failed') }
    })()`) as Record<string, { tone: string; pulses: boolean }>

    expect(tones.review).toEqual({ tone: 'violet', pulses: true })
    // Terminal rows are still — the pulse means "transitioning", and these are not.
    expect(tones.done).toEqual({ tone: 'success', pulses: false })
    expect(tones.failed).toEqual({ tone: 'danger', pulses: false })

    // The design system's size rule, resolved by the real CSS rather than asserted from a class.
    expect(
      browser.evaluate(
        `getComputedStyle(document.querySelector('[data-run-id="fix-done"] [data-slot="status-dot"]')).width`
      )
    ).toBe('7px')
  })

  it('links a row to its task, and the PR chip to the PR', () => {
    expect(browser.evaluate(`document.querySelector('[data-run-id="fix-done"] a').getAttribute('href')`)).toBe(
      scoped('/tasks/fix-done')
    )

    const chip = browser.evaluate(`(() => {
      const el = document.querySelector('[data-run-id="fix-review-pr"] [data-slot="pr-chip"]')
      return { href: el.href, target: el.target }
    })()`) as { href: string; target: string }
    expect(chip.href).toBe('https://github.com/open-mercato/cezar/pull/396')
    expect(chip.target).toBe('_blank')

    // Only the run that has one.
    expect(browser.count('[data-run-id="fix-done"] [data-slot="pr-chip"]')).toBe(0)
  })

  it('expands the variant group into per-variant rows, and collapses it again', () => {
    // Scoped to the quick-list's rows: the Tasks table (Step 3.4) legitimately lists each
    // variant as its own row, so a bare data-run-id would match the table too.
    expect(browser.count(`${ROW}[data-run-id="fix-var-a"]`)).toBe(0)

    browser.click(TILE)
    browser.waitForFunction(`document.querySelector('${ROW}[data-run-id="fix-var-a"]') !== null`)
    // What actually differs between A and B — the backend and the spend.
    expect(textOf(`${ROW}[data-run-id="fix-var-a"]`)).toBe('Aclaude · 96.2k')
    expect(textOf(`${ROW}[data-run-id="fix-var-b"]`)).toBe('Bcodex · 41.8k')
    // Each variant is still its own deep link.
    expect(
      browser.evaluate(`document.querySelector('${ROW}[data-run-id="fix-var-b"] a').getAttribute('href')`)
    ).toBe(scoped('/tasks/fix-var-b'))

    browser.screenshot(`${artifactsDir}/quick-list-expanded.png`)

    browser.click(TILE)
    browser.waitForFunction(`document.querySelector('${ROW}[data-run-id="fix-var-a"]') === null`)
  })

  it('lights the row for the task the route has open', () => {
    // A LEGACY flat deep link, on purpose: pre-multi-project bookmarks must still land, and the
    // cockpit rewrites them onto the boot project's scoped twin (BACKWARD_COMPATIBILITY.md).
    browser.goto(`${baseUrl}/tasks/fix-done`)
    browser.waitForFunction(`location.pathname === '${scoped('/tasks/fix-done')}'`)
    browser.waitForFunction(`document.querySelector('${ROW}[data-active]') !== null`)

    expect(browser.evaluate(`[...document.querySelectorAll('${ROW}[data-active]')].map((r) => r.dataset.runId)`)).toEqual(
      ['fix-done']
    )
    browser.screenshot(`${artifactsDir}/quick-list-active-row.png`)
  })

  it('switches to the archived view, and back', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list"]') !== null`)
    expect(textOf('[data-slot="view-tab"][data-view="active"]')).toBe('Active5')
    expect(textOf('[data-slot="view-tab"][data-view="archived"]')).toBe('Archived1')

    browser.click('[data-slot="view-tab"][data-view="archived"]')
    browser.waitForFunction(`document.querySelector('[data-bucket="Archived"]') !== null`)
    expect(rowsIn('Archived')).toEqual(['Sync merged PR issues1d'])
    // The active runs are gone, not merely restyled.
    expect(browser.count('[data-run-id="fix-review-pr"]')).toBe(0)

    browser.screenshot(`${artifactsDir}/quick-list-archived.png`)

    browser.click('[data-slot="view-tab"][data-view="active"]')
    browser.waitForFunction(`document.querySelector('[data-run-id="fix-review-pr"]') !== null`)
  })
})

/**
 * The Tasks table overview (Step 3.4) — the same fixture server, through the real `/` home.
 *
 * Same deliberate limitation as above: every fixture status is terminal, so the live/queued
 * columns cannot be exercised here (a serve boot recovers non-terminal runs). Those are covered
 * by the jsdom suite (`src/routes/tasks-overview.test.tsx`), which drives the components with
 * queued/running records and a stubbed usage stream directly.
 */
describe('tasks table overview', () => {
  const TABLE_ROW = '[data-slot="task-table-row"]'

  beforeAll(() => {
    browser.setViewport(1440, 900)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
  })

  it('is the home: the table renders every active fixture run with its status', () => {
    const rows = browser.evaluate(`[...document.querySelectorAll('${TABLE_ROW}')].map((tr) => ({
      id: tr.dataset.runId,
      status: tr.querySelector('[data-slot="pill"]').textContent,
    }))`) as Array<{ id: string; status: string }>

    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      'fix-review-pr': 'needs review',
      'fix-var-a': 'needs review',
      'fix-var-b': 'needs review',
      'fix-done': 'done',
      'fix-failed': 'failed',
    })
    // Needs-you first, history after — the sidebar's order, because it is the sidebar's sort.
    expect(rows.slice(0, 3).map((r) => r.id).sort()).toEqual(['fix-review-pr', 'fix-var-a', 'fix-var-b'])
    expect(rows.slice(3).map((r) => r.id)).toEqual(['fix-done', 'fix-failed'])

    // A spot check across the columns: tokens formatted, the PR chip numbered and pointed out —
    // and the Task cell shows the auto-summary, never the raw fixture title behind it.
    const reviewRow = browser.evaluate(`(() => {
      const tr = document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"]')
      const pr = tr.querySelector('[data-slot="pr-chip"]')
      return { text: tr.textContent, prHref: pr.href, prTarget: pr.target }
    })()`) as { text: string; prHref: string; prTarget: string }
    expect(reviewRow.text).toContain('128.4k')
    expect(reviewRow.text).toContain('Structured changes endpoint for the git view')
    expect(reviewRow.text).not.toContain('add a structured changes endpoint plz')
    expect(reviewRow.prHref).toBe('https://github.com/open-mercato/cezar/pull/396')
    expect(reviewRow.prTarget).toBe('_blank')

    browser.screenshot(`${artifactsDir}/tasks-table.png`)
  })

  it('fills the ± column where a run recorded a diff, and keeps the honest dash where none exists', () => {
    // Column 5 is ± (Status | Task | Workflow | Branch | ±) — read it for every row at once.
    const diffs = browser.evaluate(`Object.fromEntries(
      [...document.querySelectorAll('${TABLE_ROW}')].map((tr) => [
        tr.dataset.runId,
        tr.querySelector('td:nth-child(5)').textContent,
      ])
    )`) as Record<string, string>

    expect(diffs).toEqual({
      'fix-review-pr': '+128 −14',
      'fix-var-a': '—', // no diffStat on these fixture records — nothing is fabricated
      'fix-var-b': '—',
      'fix-done': '+9 −2',
      'fix-failed': '—',
    })
  })

  it('offers the compare strip for the finished variant group', () => {
    expect(browser.text('[data-slot="compare-strip"]')).toContain('Add skills autocomplete to composer')
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="compare-strip"] a[href$="/compare/fix-group-1"]').getAttribute('href')`
      )
    ).toBe(scoped('/compare/fix-group-1'))
  })

  it('flips both the table and the sidebar from the header tabs — one shared state', () => {
    browser.click('[data-slot="overview-tab"][data-view="archived"]')
    browser.waitForFunction(`document.querySelector('${TABLE_ROW}[data-run-id="fix-archived"]') !== null`)
    expect(browser.count(TABLE_ROW)).toBe(1)
    // The sidebar followed without being touched.
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="view-tab"][data-view="archived"]').getAttribute('aria-pressed')`
      )
    ).toBe('true')
    expect(browser.count('[data-slot="task-row"][data-run-id="fix-review-pr"]')).toBe(0)

    // And back, this time from the sidebar: the table follows.
    browser.click('[data-slot="view-tab"][data-view="active"]')
    browser.waitForFunction(`document.querySelector('${TABLE_ROW}[data-run-id="fix-review-pr"]') !== null`)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="overview-tab"][data-view="active"]').getAttribute('aria-pressed')`
      )
    ).toBe('true')
    expect(browser.count(`${TABLE_ROW}[data-run-id="fix-archived"]`)).toBe(0)
  })

  it('opens the task from a row click', () => {
    browser.click(`${TABLE_ROW}[data-run-id="fix-done"]`)
    browser.waitForFunction(`location.pathname === '${scoped('/tasks/fix-done')}'`)
    expect(browser.url()).toContain(scoped('/tasks/fix-done'))
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('${TABLE_ROW}').length > 0`)
  })

  it('renames a task inline from its row — the hover pencil, committed by Enter, stored for real', async () => {
    const row = `${TABLE_ROW}[data-run-id="fix-failed"]`
    // The pencil is a hover affordance (mockup `.task-title .pencil`): produce a real pointer.
    browser.hover(row)
    browser.click(`${row} [data-slot="row-rename"]`)
    browser.waitForFunction(`document.querySelector('${row} [data-slot="title-input"]') !== null`)
    // Viewport mode: a full-page capture scrolls the document, and this shot exists to show the
    // open editor exactly as the user sees it.
    browser.screenshot(`${artifactsDir}/tasks-table-row-edit.png`, { viewport: true })

    browser.fill(`${row} [data-slot="title-input"]`, 'Bump zod to v4 — second attempt')
    browser.press('Enter')

    // The readback, twice over. First the UI: the PATCH invalidates `runs`, the refetched list
    // re-renders the row under its new name and the editor is gone.
    browser.waitForFunction(
      `document.querySelector('${row}').textContent.includes('Bump zod to v4 — second attempt')`
    )
    expect(browser.count(`${row} [data-slot="title-input"]`)).toBe(0)

    // Then the record: the server stored the edit as BOTH title and the displayed summary
    // (an edit must beat any past or future auto-summary).
    const runs = (await fetch(`${baseUrl}/api/v1/runs`).then((r) => r.json())) as Array<{
      id: string
      title: string
      titleSummary?: string
    }>
    const renamed = runs.find((r) => r.id === 'fix-failed')
    expect(renamed?.title).toBe('Bump zod to v4 — second attempt')
    expect(renamed?.titleSummary).toBe('Bump zod to v4 — second attempt')
  })

  it('reflows to cards plus a New-task FAB at phone width, with no horizontal overflow', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="task-card"]').length > 0`)

    expect(browser.count('[data-slot="task-card"]')).toBe(5)
    expect(browser.isVisible('[data-slot="new-task-fab"]')).toBe(true)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="new-task-fab"]').getAttribute('href')`)
    ).toBe(scoped('/new'))
    // The table is the desktop framing — at phone width the cards replace it, not join it.
    expect(
      browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="tasks-table"]')).display`)
    ).toBe('none')
    // Nothing forces the page wider than the phone.
    expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)
    expect(
      browser.evaluate(`(() => {
        const main = document.querySelector('[data-slot="main"]')
        return main.scrollWidth <= main.clientWidth
      })()`)
    ).toBe(true)

    browser.screenshot(`${artifactsDir}/tasks-cards-mobile.png`)
    browser.setViewport(1440, 900)
  })
})

/** The other half of the truth: with no runs, the sidebar says so rather than inventing any. */
describe('empty quick-list', () => {
  let emptyServer: ChildProcess
  let emptyRoot: string
  let emptyUrl: string
  let emptyProject: string

  beforeAll(async () => {
    emptyRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-empty-'))
    const port = await freePort()
    emptyUrl = `http://localhost:${port}`
    emptyServer = spawn(
      process.execPath,
      [join(repoRoot, 'dist/index.js'), 'serve', '--repo', emptyRoot, '--port', String(port), '--no-open'],
      { env: fixtureServeEnv(emptyRoot), stdio: 'ignore' }
    )
    await waitForHealth(emptyUrl)
    emptyProject = await bootProjectId(emptyUrl)
  }, 60_000)

  afterAll(() => {
    emptyServer?.kill()
    if (emptyRoot) rmSync(emptyRoot, { recursive: true, force: true })
  })

  it('shows the honest empty state — a fresh cezar has nothing to list', () => {
    browser.goto(`${emptyUrl}/p/${emptyProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="quick-list"]') !== null`)

    expect(browser.text('[data-slot="quick-list"]')).toContain('No tasks yet — describe one.')
    expect(browser.count(ROW)).toBe(0)
    expect(browser.count('[data-slot="quick-list-bucket"]')).toBe(0)

    browser.screenshot(`${artifactsDir}/quick-list-empty.png`)
  })
})
