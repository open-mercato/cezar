import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, fixtureServeEnv } from './agent-browser'
import { largeThreadEvents } from './fixtures/make-large-thread'
import record from './fixtures/thread-run.record.json'

const repoRoot = resolve(import.meta.dirname, '../../..')
const artifactsDir = resolve(repoRoot, '.ai/qa/artifacts_e2e')
const sessionId = `e2e-progressive-history-${process.pid}`
const RUN_ID = 'cccccccc-1111-4222-8333-dddddddddddd'
const RUN_B_ID = 'eeeeeeee-1111-4222-8333-ffffffffffff'
const RUN = {
  ...record,
  id: RUN_ID,
  title: 'Progressively page a very long session',
  titleSummary: 'Progressively page a long session',
  task: 'Inspect a long session without downloading the archive.',
  status: 'running',
  finishedAt: undefined,
  steps: [record.steps[0]],
  pullRequestUrl: undefined,
}
const RUN_B = {
  ...RUN,
  id: RUN_B_ID,
  title: 'Restore a second long session without jumping',
  titleSummary: 'Restore a second long session',
  task: 'Keep a second long session at its cached reading position.',
}

const contextPrefix = [
  {
    type: 'turn.started',
    turnId: 'context-turn',
    stepId: 'task',
  },
  {
    type: 'plan.updated',
    stepId: 'task',
    entries: [{ content: 'Keep the current plan visible', status: 'in_progress' }],
  },
  {
    type: 'item.started',
    stepId: 'task',
    item: {
      kind: 'tool',
      id: 'history-agent',
      name: 'Task',
      toolKind: 'task',
      title: 'Task: watch current history work',
      status: 'running',
    },
  },
]

const events = [...contextPrefix, ...largeThreadEvents(300)].map((event, index) => ({
  ...event,
  seq: index + 1,
  ts: new Date(Date.parse('2026-07-30T00:00:00.000Z') + index * 10).toISOString(),
}))

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/v1/health`)).ok) return
    } catch {
      // Server startup is expected to race the first probes.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`cezar e2e: fixture server never answered at ${baseUrl}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const cursorRequestCount = `performance.getEntriesByType('resource').filter((entry) => {
  const url = new URL(entry.name)
  return url.pathname.endsWith('/runs/${RUN_ID}/history') && url.searchParams.has('cursor')
}).length`

function activateHistoryBoundary(): void {
  browser.evaluate(`document.querySelector('[data-slot="history-boundary"] button').focus()`)
  browser.press('Enter')
}

type ArrivalSample = { top: number; maxTop: number }

/** Capture every destination-transcript animation frame around a client-side task switch. */
function navigateAndSampleArrival(runId: string): ArrivalSample[] {
  const href = `/p/${bootProject}/tasks/${runId}`
  browser.evaluate(`(() => {
    const link = document.querySelector(${JSON.stringify(`a[href="${href}"]`)})
    if (!link) throw new Error('missing task navigation link: ${href}')
    window.__cezArrivalSamples = []
    let attempts = 0
    const sample = () => {
      attempts += 1
      const main = document.querySelector('[data-slot="main"]')
      const destination = document.querySelector(
        ${JSON.stringify(`[data-route="task-thread"][data-run-id="${runId}"]`)},
      )
      const ready = destination?.querySelector('[data-slot="thread-rows"]')
      if (main && ready) {
        window.__cezArrivalSamples.push({
          top: main.scrollTop,
          maxTop: main.scrollHeight - main.clientHeight,
        })
      }
      if (window.__cezArrivalSamples.length < 6 && attempts < 120) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    link.click()
  })()`)
  browser.waitForFunction(`window.__cezArrivalSamples?.length >= 6`)
  return browser.evaluate(`window.__cezArrivalSamples`) as ArrivalSample[]
}

function parkCurrentThread(): number {
  return Number(browser.evaluate(`(() => {
    const main = document.querySelector('[data-slot="main"]')
    main.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    main.scrollTop = Math.max(160, Math.round((main.scrollHeight - main.clientHeight) / 2))
    main.dispatchEvent(new Event('scroll', { bubbles: true }))
    return main.scrollTop
  })()`))
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-progressive-history-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN, RUN_B], null, 2), 'utf8')
  for (const runId of [RUN_ID, RUN_B_ID]) {
    writeFileSync(
      join(dataRoot, '.ai/cezar/runs', `${runId}.ndjson`),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    )
  }
  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [join(repoRoot, 'packages/cezar/dist/index.js'), 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
  browser.waitForFunction(
    `document.querySelector('[data-route="task-thread"]') !== null &&
     document.querySelector('[data-slot="thread-rows"]') !== null`,
  )
  browser.waitForFunction(
    `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '1' &&
     document.querySelector('[data-slot="history-boundary"] button:not([disabled])') !== null`,
  )
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  try {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // The killed fixture may still be releasing its transcript file; the OS reaps the temp dir.
  }
})

describe('progressive long-session history', () => {
  it('paints the current tail and docks without requesting an earlier page', () => {
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(0)
    expect(browser.text('[data-slot="plan-dock"]')).toContain('Keep the current plan visible')
    expect(browser.text('[data-slot="agents-dock"]')).toContain('0/1')
    expect(browser.count('[data-slot="thread-row"]')).toBeLessThan(300)
    browser.screenshot(join(artifactsDir, 'progressive-history-tail.png'), { viewport: true })
  })

  it('loads exactly one page from the accessible control and preserves a bounded page count', async () => {
    activateHistoryBoundary()
    browser.waitForFunction(`${cursorRequestCount} === 1`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '2'`,
    )
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(1)
    browser.screenshot(join(artifactsDir, 'progressive-history-earlier-page.png'), { viewport: true })
    // Let the prepend anchor's requestAnimationFrame settle before the next test supplies
    // a genuinely fresh upward gesture.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  })

  it('consumes one upward intent without cascading while the boundary remains near', async () => {
    browser.evaluate(`(() => {
      const main = document.querySelector('[data-slot="main"]')
      main.scrollTop = 0
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    })()`)
    browser.waitForFunction(`${cursorRequestCount} === 2`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    expect(Number(browser.evaluate(cursorRequestCount))).toBe(2)
  })

  it('caps retained pages at five and jumps directly back to a fresh tail', () => {
    let page = Number(browser.evaluate(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages`,
    ))
    while (page < 5) {
      page += 1
      activateHistoryBoundary()
      browser.waitForFunction(
        `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '${page}'`,
      )
    }
    expect(Number(browser.evaluate(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages`,
    ))).toBe(5)
    browser.evaluate(`document.querySelector('[data-slot="main"]').scrollTop = 0`)
    browser.waitForFunction(`document.querySelector('[data-slot="jump-to-latest"]') !== null`)
    browser.click('[data-slot="jump-to-latest"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="history-boundary"]')?.dataset.retainedPages === '1'`,
    )
  })

  it('switches between cached and live-tail threads without a near-zero destination frame', () => {
    // The preceding paging case deliberately visited the archive boundary. Establish the first
    // run's departure state as an explicit live-tail cache entry before warming the second run.
    browser.evaluate(`(() => {
      const main = document.querySelector('[data-slot="main"]')
      main.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
      main.scrollTop = main.scrollHeight - main.clientHeight
      main.dispatchEvent(new Event('scroll', { bubbles: true }))
    })()`)
    browser.waitForFunction(
      `(() => { const main = document.querySelector('[data-slot="main"]'); return main.scrollHeight - main.scrollTop - main.clientHeight < 80 })()`,
    )

    // Warm both query caches first. The destination transcript, not a loading placeholder, is
    // the surface whose paint ordering this regression measures.
    const firstTailArrival = navigateAndSampleArrival(RUN_B_ID)
    expect(firstTailArrival.at(-1)!.maxTop - firstTailArrival.at(-1)!.top).toBeLessThan(80)
    const parked = parkCurrentThread()
    expect(parked).toBeGreaterThan(100)

    const liveTailArrival = navigateAndSampleArrival(RUN_ID)
    expect(Math.min(...liveTailArrival.map(({ top }) => top))).toBeGreaterThan(40)
    expect(liveTailArrival.at(-1)!.maxTop - liveTailArrival.at(-1)!.top).toBeLessThan(80)

    const cachedArrival = navigateAndSampleArrival(RUN_B_ID)
    expect(Math.min(...cachedArrival.map(({ top }) => top))).toBeGreaterThan(40)
    expect(Math.abs(cachedArrival[0]!.top - parked)).toBeLessThan(200)
    expect(Math.abs(cachedArrival.at(-1)!.top - parked)).toBeLessThan(200)
    browser.screenshot(join(artifactsDir, 'progressive-history-thread-switch.png'), { viewport: true })

    browser.setViewport(390, 844)
    const mobileTailArrival = navigateAndSampleArrival(RUN_ID)
    expect(Math.min(...mobileTailArrival.map(({ top }) => top))).toBeGreaterThan(40)
    expect(mobileTailArrival.at(-1)!.maxTop - mobileTailArrival.at(-1)!.top).toBeLessThan(80)
    browser.screenshot(join(artifactsDir, 'progressive-history-thread-switch-mobile.png'), {
      viewport: true,
    })
    browser.setViewport(1440, 900)
  }, 90_000)
})
