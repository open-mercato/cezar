import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { expectedRowCount, largeThreadEvents } from './fixtures/make-large-thread'
import record from './fixtures/thread-run.record.json'

/**
 * R3 Step 2.4 in a real browser: virtualization on a LARGE transcript (the synthetic
 * 250-turn NDJSON from make-large-thread.ts — real wire shapes, >2,000 events, >1,000
 * rendered rows), the stick/jump behavior, the per-run scroll cache across a client-side
 * round trip, and the iPhone-viewport composer.
 *
 * HONESTY NOTES on what a headless browser can and cannot prove:
 *  - Smoothness is asserted by proxy: the DOM stays bounded under virtualization (rendered
 *    row count and total element count, compared against the SAME transcript force-rendered
 *    flat via `?thread=flat` — the measurement seam in thread-scroll.ts).
 *  - The iOS keyboard cannot be driven headless. The `--kb` adapter math is unit-tested
 *    against stub viewports (lib/keyboard-inset.test.ts); here the test drives the CSS seam
 *    it feeds (`--kb` → the dock's `bottom`) and verifies the composer fits an iPhone
 *    viewport. Real-device keyboard behavior remains a manual checklist item.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-thread-scroll-${process.pid}`

const TURNS = 250
const ROWS = expectedRowCount(TURNS) // 1002 — comfortably past the ~300 threshold

const RUN_ID = 'aaaaaaaa-1111-4222-8333-bbbbbbbbcccc'
/** The real record fixture, re-ided for the synthetic transcript; the untouched fields keep
 *  the store's zod shape. No PR url (this run never shipped one) and only the agent step. */
const RUN = {
  ...record,
  id: RUN_ID,
  title: 'Walk the whole git history in passes',
  titleSummary: 'Walk the whole git history',
  task: 'Walk the whole git history in passes.',
  tokensUsed: TURNS * 150,
  steps: [record.steps[0]],
  pullRequestUrl: undefined,
}

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

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

const MAIN = `document.querySelector('[data-slot="main"]')`
const nearBottom = `(() => { const m = ${MAIN}; return m.scrollHeight - m.scrollTop - m.clientHeight < 80 })()`
const rowCount = () => browser.count('[data-slot="thread-row"]')
const domSize = () => Number(browser.evaluate(`document.querySelectorAll('*').length`))
const assistantWidth = () =>
  Number(browser.evaluate(`document.querySelector('[data-slot="assistant-message"]')?.getBoundingClientRect().width ?? 0`))

/**
 * Scroll away from the tail like a reader would — and INSIST, like a reader would.
 * The wheel gesture is what unpins the thread (unpinning is intent-based); the scrollTop
 * write is the e2e's stand-in for the native scroll a real wheel performs. Raw writes can
 * lose a same-frame race against virtua's jump compensation (which real, event-synced
 * native scrolling doesn't hit), so the park is a polled retry until it holds.
 * `target` is a JS expression evaluated against the scroller (`m`).
 */
function parkAt(target: string) {
  browser.waitForFunction(`(() => {
    const m = ${MAIN}
    const target = ${target}
    if (Math.abs(m.scrollTop - target) > 50) {
      m.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
      m.scrollTop = target
      return false
    }
    return true
  })()`)
}

/** Load the thread and wait until the SSE replay has finished growing it (the last turn's
 *  note is rendered) — every measurement below is over the complete transcript. */
function openThread(query = '') {
  browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}${query}`)
  browser.waitForFunction(
    `document.querySelector('[data-slot="thread-rows"]') !== null && document.body.textContent.includes('goal achieved — session closed')`,
  )
}

/** Grow the retained window by N earlier pages through the accessible boundary control. */
function loadEarlierPages(n: number): void {
  for (let i = 0; i < n; i += 1) {
    const before = Number(
      browser.evaluate(`document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages ?? '1'`),
    )
    // The explicit button needs no arming — click it directly and wait out the page.
    browser.waitForFunction(
      `(() => { const b = document.querySelector('[data-slot="history-boundary"] button'); return !!b && !b.disabled })()`,
    )
    browser.evaluate(`document.querySelector('[data-slot="history-boundary"] button').click()`)
    try {
      browser.waitForFunction(
        `Number(document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages ?? '1') === ${before + 1}`,
      )
    } catch (error) {
      console.log('DBG boundary', browser.evaluate(`(() => { const b=document.querySelector('[data-slot="history-boundary"]'); return { text: b?.textContent, pages: b?.dataset.retainedPages, rows: document.querySelectorAll('[data-slot="thread-row"]').length } })()`))
      throw error
    }
    // The anchor-preserving load releases its in-flight guard one frame AFTER the data lands —
    // give it that frame, or the next click falls into the gap and no-ops.
    browser.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  }
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-thread-scroll-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN], null, 2), 'utf8')
  writeFileSync(
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`),
    largeThreadEvents(TURNS)
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
    'utf8',
  )

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
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  // The killed server may still be flushing its NDJSON into dataRoot, which races rmSync and
  // throws ENOTEMPTY — a suite-level failure on a run whose every test passed. A temp dir that
  // outlives the run is litter, not a failure; the OS reaps it.
  try {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* the OS reaps it */
  }
})

describe('thread virtualization on a 1,000-row transcript', () => {
  let flatRows = 0
  let flatDom = 0
  let flatAssistantWidth = 0

  it('starts flat on the tail page (the before measurement)', () => {
    // Progressive history loads the TAIL page first (its own spec covers the paging): under
    // the ~300-row threshold the thread honestly renders flat.
    openThread()
    expect(browser.evaluate(`document.querySelector('[data-slot="thread-rows"]').dataset.virtualized`)).toBe('false')
    flatRows = rowCount()
    flatDom = domSize()
    flatAssistantWidth = assistantWidth()
    expect(flatRows).toBeGreaterThan(50)
    expect(flatAssistantWidth).toBeGreaterThan(200)
  }, 90_000)

  it('virtualizes once the retained window crosses the threshold, and keeps the DOM bounded', () => {
    loadEarlierPages(3)
    browser.waitForFunction(`document.querySelector('[data-slot="thread-rows"]').dataset.virtualized === 'true'`)

    const virtualRows = rowCount()
    const virtualDom = domSize()
    // The honest metric: with FOUR retained pages on screen, virtua holds a viewport window
    // plus overscan — fewer live rows and elements than even the flat single tail page.
    expect(virtualRows).toBeGreaterThan(0)
    expect(virtualRows).toBeLessThan(flatRows / 2)
    expect(virtualDom).toBeLessThan(flatDom)
    const virtualAssistantWidth = assistantWidth()
    expect(virtualAssistantWidth).toBeGreaterThan(200)
    expect(Math.abs(virtualAssistantWidth - flatAssistantWidth)).toBeLessThan(2)
    // The numbers themselves are checkpoint material — persisted next to the screenshots.
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(
      join(artifactsDir, 'thread-scroll-metrics.json'),
      JSON.stringify({ transcriptEvents: largeThreadEvents(TURNS).length, rows: { flatTail: flatRows, virtualized: virtualRows }, domElements: { flatTail: flatDom, virtualized: virtualDom } }, null, 2),
      'utf8',
    )
  }, 90_000)

  it('arrives pinned to the live tail (bottom-anchored), with no jump pill', () => {
    openThread()
    expect(browser.evaluate(nearBottom)).toBe(true)
    expect(browser.count('[data-slot="jump-to-latest"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/thread-long-desktop.png`)
  })

  it('scrolling up shows the jump pill; clicking it returns to the tail', () => {
    // A fresh tail-page thread, parked MID-transcript: at the very top the history boundary
    // owns the intent (it loads an earlier page), so the pill's home is the detached middle.
    openThread()
    parkAt(`Math.round((m.scrollHeight - m.clientHeight) / 2)`)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') !== null`)
    // Viewport shot: full-page capture scroll-stitches 48k px and re-pins the thread,
    // unmounting the very pill this is photographing.
    browser.screenshot(`${artifactsDir}/thread-jump-pill.png`, { viewport: true })

    browser.click('[data-slot="jump-to-latest"]')
    browser.waitForFunction(nearBottom)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') === null`)
    // Let the smooth scroll LAND, not merely enter the near-bottom slack — the next test
    // parks mid-thread, and a still-running animation would carry its park away.
    browser.waitForFunction(
      `(() => { const m = ${MAIN}; return Math.abs(m.scrollHeight - m.clientHeight - m.scrollTop) < 2 })()`,
    )
  })

  it('restores the scroll position across a client-side leave and return', () => {
    // Park mid-thread (a position the arrival logic would never pick on its own).
    parkAt(`Math.round((m.scrollHeight - m.clientHeight) / 2)`)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') !== null`)
    const parked = Number(browser.evaluate(`${MAIN}.scrollTop`))
    expect(parked).toBeGreaterThan(1000)
    const maxTop = Number(browser.evaluate(`${MAIN}.scrollHeight - ${MAIN}.clientHeight`))
    expect(maxTop - parked).toBeGreaterThan(1000) // genuinely mid-thread, not a near-tail park

    // …leave through the sidebar (a client-side <Link> — a reload would drop the caches)…
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/')}"]`)
    browser.waitForFunction(`document.querySelector('[data-route="task-thread"]') === null`)

    // …and come back through the quick list.
    browser.click(`a[href="${scoped(`/tasks/${RUN_ID}`)}"]`)
    browser.waitForFunction(`document.querySelector('[data-slot="thread-rows"]') !== null`)
    // The replay re-grows the thread; the cached offset is re-applied until reachable.
    browser.waitForFunction(`Math.abs(${MAIN}.scrollTop - ${parked}) < 200`)
    expect(browser.evaluate(nearBottom)).toBe(false) // back where the reader parked, not the tail
  }, 90_000)
})

describe('iPhone viewport (390×844)', () => {
  it('keeps the composer visible and wired to the --kb keyboard lift', () => {
    browser.setViewport(390, 844)
    openThread()

    // The composer dock fits the visual viewport (no keyboard yet: --kb is unset ⇒ 0px).
    const dock = browser.evaluate(`(() => {
      const dock = document.querySelector('[data-slot="thread-dock"]')
      const rect = dock.getBoundingClientRect()
      return { bottomGap: window.innerHeight - rect.bottom, cssBottom: getComputedStyle(dock).bottom }
    })()`) as { bottomGap: number; cssBottom: string }
    expect(dock.bottomGap).toBeGreaterThanOrEqual(0)
    expect(dock.cssBottom).toBe('0px')

    // The keyboard seam, driven directly: publishing --kb (what the visualViewport watcher
    // does on a real device — unit-tested against stubs) lifts the sticky dock by exactly
    // that inset. The keyboard itself cannot be summoned in a headless browser.
    browser.evaluate(`document.documentElement.style.setProperty('--kb', '280px')`)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="thread-dock"]')).bottom`)).toBe('280px')
    browser.evaluate(`document.documentElement.style.removeProperty('--kb')`)
    expect(browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="thread-dock"]')).bottom`)).toBe('0px')

    browser.screenshot(`${artifactsDir}/thread-iphone.png`, { viewport: true })
    browser.setViewport(1440, 900)
  }, 90_000)
})
