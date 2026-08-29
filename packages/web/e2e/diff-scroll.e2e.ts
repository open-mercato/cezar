import { execFileSync } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * Diff virtualization in a real browser (`components/diff/diff-scroll.ts` §"THE PERFORMANCE
 * RULE"), over a changeset this spec BUILDS — a throwaway git repo with a deliberately large
 * uncommitted diff, served by its own cezar instance.
 *
 * The fixture is generated rather than read from the checkout on purpose. An earlier version
 * of this spec measured whatever the working tree happened to hold, which made it silently
 * worthless the moment the tree was clean or small (cezar's autosave commits as a task runs,
 * so "small" is the normal state). A regression test for a size threshold has to control the
 * size.
 *
 * The `?diff=flat` / `?diff=virtual` override is the measurement seam: the SAME changeset is
 * loaded both ways and the DOM counted each time, mirroring `thread-scroll.e2e.ts`.
 *
 * HONESTY NOTES on what this can and cannot prove:
 *  - Smoothness is asserted by proxy — a bounded DOM — not measured as frame timing.
 *  - Sticky headers and the `startMargin` offset are the two things virtua could plausibly
 *    break here, and both are checked against real layout, which is why they live in an e2e
 *    at all: jsdom lays nothing out, so neither is observable in a unit test.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-diff-scroll-${process.pid}`

/**
 * 120 files × ~18 rows ≈ 2,100 rendered rows — past the 1,500 threshold.
 *
 * MANY SMALL FILES, deliberately, not a few huge ones. Card height has to stay well under the
 * viewport for the `startMargin` assertion below to be able to fail: when one card is taller
 * than the screen, the item covering the fold is the same item the window is centred on, so a
 * wrong start offset can never expose a gap and the test silently proves nothing. (Verified:
 * with 8 × 250-line files the assertion passed against known-broken code.)
 */
const FIXTURE_FILES = 120
const LINES_PER_FILE = 8

const MAIN = `document.querySelector('[data-slot="main"]')`
const domSize = () => Number(browser.evaluate(`document.querySelectorAll('*').length`))
const lineCount = () => browser.count('[data-slot="diff-line"]')

let browser: AgentBrowser
let server: ChildProcess
let repo: string
let baseUrl: string
/** The server's own count. NOT `FIXTURE_FILES`: booting cezar against the fixture writes
 *  `.ai/cezar/.gitignore` into it, which is itself an honest untracked change the view shows. */
let changedFiles = 0

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

/** Commit a baseline, then rewrite every line — a big, honest modified-file diff. */
function buildFixtureRepo(dir: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'cezar e2e'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  const write = (index: number, tag: string) =>
    writeFileSync(
      join(dir, 'src', `module-${index}.ts`),
      Array.from({ length: LINES_PER_FILE }, (_, line) => `export const ${tag}_${index}_${line} = ${line}`).join('\n') + '\n',
      'utf8',
    )
  for (let index = 0; index < FIXTURE_FILES; index += 1) write(index, 'before')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])
  for (let index = 0; index < FIXTURE_FILES; index += 1) write(index, 'after')
}

/** Which mode is currently loaded, so the virtual-mode tests can share one page load. */
let loaded: 'flat' | 'virtual' | null = null

/**
 * Load /git in a forced mode and wait until the diff has rendered in that mode — and skip the
 * navigation entirely when that mode is already up. Re-loading is the expensive part of this
 * spec (flat mode paints ~1,900 highlighted rows, which is precisely the cost being measured),
 * so the three virtual-mode assertions below deliberately share a single load and run in order.
 */
function openChanges(mode: 'flat' | 'virtual') {
  if (loaded === mode) return
  browser.goto(`${baseUrl}/git?diff=${mode}`)
  browser.waitForFunction(
    `document.querySelector('[data-slot="diff-files"]')?.dataset.virtualized === '${mode === 'virtual'}'`,
  )
  browser.waitForFunction(`document.querySelector('[data-slot="diff-file"]') !== null`)
  loaded = mode
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'cezar-e2e-diff-scroll-'))
  buildFixtureRepo(repo)

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', repo, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(repo), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  changedFiles = ((await (await fetch(`${baseUrl}/api/v1/repo/changes`)).json()) as { files: unknown[] }).files.length
  expect(changedFiles).toBeGreaterThanOrEqual(FIXTURE_FILES)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  // The server may still be flushing its own state into the fixture as it dies; a temp dir
  // that outlives the run is litter, not a failure, so cleanup never fails the suite.
  try {
    if (repo) rmSync(repo, { recursive: true, force: true })
  } catch {
    /* the OS reaps it */
  }
})

describe(`diff virtualization on a generated ${FIXTURE_FILES}-file changeset`, () => {
  let flatLines = 0
  let flatDom = 0

  it('force-flat renders every file and every line (the before measurement)', () => {
    openChanges('flat')

    expect(browser.count('[data-slot="diff-file"]')).toBe(changedFiles)
    flatLines = lineCount()
    flatDom = domSize()
    // Every line of every file: ~2 rows per changed line (a del and an add).
    expect(flatLines).toBeGreaterThan(FIXTURE_FILES * LINES_PER_FILE)
  }, 120_000)

  it('force-virtual holds a viewport window instead of the whole changeset', () => {
    openChanges('virtual')

    const virtualLines = lineCount()
    const virtualDom = domSize()
    // The honest metric, same changeset, same browser: virtua mounts the cards it needs, not
    // the list. The exact window varies with file sizes — the BOUND is the claim.
    expect(virtualLines).toBeLessThan(flatLines / 5)
    expect(virtualDom).toBeLessThan(flatDom / 2)
    expect(browser.count('[data-slot="diff-file"]')).toBeLessThan(changedFiles)

    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(
      join(artifactsDir, 'diff-scroll-metrics.json'),
      JSON.stringify(
        {
          fixture: { files: changedFiles, linesPerFile: LINES_PER_FILE },
          diffRows: { flat: flatLines, virtualized: virtualLines },
          domElements: { flat: flatDom, virtualized: virtualDom },
        },
        null,
        2,
      ),
      'utf8',
    )
    browser.screenshot(`${artifactsDir}/diff-virtualized.png`)
  }, 120_000)

  it('keeps the per-file header sticky while virtualized — the layout hazard virtua poses', () => {
    openChanges('virtual')
    browser.waitForFunction(`(() => { ${MAIN}.scrollTop = 900; return true })()`)

    // A header whose card still covers the viewport top must be pinned AT that top edge, not
    // scrolled away with its card. virtua absolutely-positions every item, which is exactly
    // the layout that could silently kill `position: sticky`.
    const pinned = browser.evaluate(`(() => {
      const scroller = ${MAIN}
      const top = scroller.getBoundingClientRect().top
      for (const card of document.querySelectorAll('[data-slot="diff-file"]')) {
        const box = card.getBoundingClientRect()
        const header = card.querySelector('[data-slot="diff-file-header"]')
        if (!header) continue
        if (box.top < top && box.bottom > top + 40) {
          return { straddling: true, headerTop: Math.round(header.getBoundingClientRect().top - top), cardTop: Math.round(box.top - top) }
        }
      }
      return { straddling: false }
    })()`) as { straddling: boolean; headerTop?: number; cardTop?: number }

    expect(pinned.straddling, 'no card straddled the fold — the sticky check did not run').toBe(true)
    // Sticky means the header sits at the scrollport top even though its card began above it.
    // Without sticky it would ride at `cardTop`, which is negative here.
    expect(pinned.cardTop!).toBeLessThan(0)
    expect(pinned.headerTop!).toBeGreaterThan(pinned.cardTop!)
    expect(pinned.headerTop!).toBeGreaterThanOrEqual(0)
  }, 120_000)

  it('mounts cards that actually cover the viewport after scrolling (startMargin is real)', () => {
    openChanges('virtual')
    browser.waitForFunction(`(() => { ${MAIN}.scrollTop = 1200; return true })()`)

    // virtua positions its window from the scroll offset MINUS the distance down to the list
    // (`startMargin`). Get that wrong — measuring it before the scroller ref is attached pins
    // it at 0 — and the window is computed for a point further down the list than the reader
    // is at, leaving an uncovered band at the top of the viewport once the buffer runs out.
    const gap = browser.evaluate(`(() => {
      const scroller = ${MAIN}
      const fold = scroller.getBoundingClientRect().top
      const tops = [...document.querySelectorAll('[data-slot="diff-file"]')]
        .map((card) => card.getBoundingClientRect().top - fold)
      if (tops.length === 0) return null
      return Math.round(Math.min(...tops))
    })()`) as number | null

    expect(gap, 'no diff cards mounted at all').not.toBeNull()
    // The topmost mounted card starts at or above the fold — no uncovered band.
    expect(gap!).toBeLessThanOrEqual(0)
  }, 120_000)

  /**
   * The file tree is its OWN scroller, not a passenger on the page's. This fixture is the only
   * place with a tree taller than the viewport (120+ files), which is exactly the shape that was
   * broken: the pane was `sticky` but unbounded, so it grew the page instead of scrolling, and
   * the last file could only be reached by dragging `main` — the diff — to the bottom.
   */
  it('scrolls the file tree independently of the diff', () => {
    openChanges('virtual')

    const pane = browser.evaluate(`(() => {
      const pane = document.querySelector('[data-slot="changes-tree-pane"]')
      if (!pane) return null
      const scroller = ${MAIN}
      return {
        rows: pane.querySelectorAll('[data-slot="tree-file"]').length,
        overflow: Math.round(pane.scrollHeight - pane.clientHeight),
        paneBottom: Math.round(pane.getBoundingClientRect().bottom),
        scrollerBottom: Math.round(scroller.getBoundingClientRect().bottom),
        mainTop: Math.round(scroller.scrollTop),
      }
    })()`) as {
      rows: number
      overflow: number
      paneBottom: number
      scrollerBottom: number
      mainTop: number
    } | null

    expect(pane, 'the tree pane did not render — is the viewport below md?').not.toBeNull()
    // The premise: more files than fit. Without it the rest proves nothing.
    expect(pane!.rows).toBeGreaterThan(FIXTURE_FILES / 2)
    expect(pane!.overflow, 'the tree pane is unbounded — it grows the page instead of scrolling').toBeGreaterThan(0)
    // Capped by the room under the sticky chrome: the pane's bottom edge sits inside the
    // scrollport. Edges, not heights — a height comparison passes with the cap's whole slack to
    // spare and so would stay green even with the pane hanging below the fold, which is the one
    // failure mode this cap exists to prevent.
    expect(pane!.paneBottom, 'the tree pane hangs below the fold').toBeLessThanOrEqual(pane!.scrollerBottom)

    // The claim itself: the tree runs to its end while the diff stays exactly where it was.
    // Compared against the offset measured a moment ago, not against 0 — the specs above share
    // this page load and leave `main` scrolled, and where it sits is not this test's business.
    //
    // This is a scripted scroll, so it proves the pane is its OWN scroller and that reaching the
    // last file no longer moves `main`. It says nothing about `overscroll-contain`: a scripted
    // scroll never chains to an ancestor whatever the overscroll-behavior is, and the driver's
    // input ops are pointer-based, with no wheel to send. Wheel chaining stays manual-QA territory.
    const moved = browser.evaluate(`(() => {
      const pane = document.querySelector('[data-slot="changes-tree-pane"]')
      pane.scrollTop = pane.scrollHeight
      return { paneTop: Math.round(pane.scrollTop), mainTop: Math.round(${MAIN}.scrollTop) }
    })()`) as { paneTop: number; mainTop: number }

    expect(moved.paneTop).toBeGreaterThan(0)
    expect(moved.mainTop, 'scrolling the tree dragged the diff along').toBe(pane!.mainTop)
  }, 120_000)
})
