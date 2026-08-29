import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/subagents-run.record.json'

/**
 * The grouped sub-agent display (spec `.ai/specs/2026-07-20-grouped-subagent-display.md`,
 * #474) in a real browser, against a real cezar serving a run whose transcript is a REAL
 * NDJSON file — `fixtures/subagents-run.ndjson`, the verbatim output of a `mock:subagents`
 * dry run (two parallel `Task` spawns whose children carry `parent_tool_use_id`).
 *
 * Same boot-own-server doctrine as task-thread.e2e.ts: the store reads `runs.json` once at
 * startup, so the fixture must exist before boot, and a terminal (`done`) status keeps
 * `recover()` from touching the run. The server replays it over the per-run SSE stream exactly
 * as it would for any finished run, so this covers the full pipe — store → SSE replay →
 * reducer → collector → dock → sheet.
 *
 * This is the one check the unit gate cannot make: `npm test` never boots the app, so a dock
 * that is correct in jsdom but unmounted in the real cockpit would pass everything else.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-agents-dock-${process.pid}`

const RUN = record
const RUN_ID: string = RUN.id

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
  throw new Error(`cezar e2e: the agents-dock server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-agents-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN], null, 2), 'utf8')
  // Derive a long attributed child stream from the real `mock:subagents` recording. The
  // source fixture stays verbatim; this test adds scale without pretending the runner emitted
  // data it cannot currently attribute (notably images, whose persisted v1 line has no parent).
  const recorded = readFileSync(
    resolve(import.meta.dirname, 'fixtures/subagents-run.ndjson'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const taskCompletion = recorded.findIndex(
    (event) =>
      event.type === 'item.completed' &&
      (event.item as { id?: string } | undefined)?.id === 'toolu_task_a_1',
  )
  const longChildren = Array.from({ length: 34 }, (_, index) => ({
    type: 'item.completed',
    item: {
      kind: 'tool',
      id: `toolu_sub_long_${index}`,
      name: 'Bash',
      toolKind: 'execute',
      title: `Ran long check ${index + 1}`,
      status: 'completed',
      output: `long check ${index + 1} passed`,
      exitCode: 0,
      parentItemId: 'toolu_task_a_1',
    },
    stepId: 'task',
  }))
  recorded.splice(taskCompletion, 0, ...longChildren)
  const scaled = recorded
    .map((event, index) =>
      JSON.stringify({
        ...event,
        seq: index + 1,
        ts: new Date(Date.UTC(2026, 6, 21, 10, 0, index)).toISOString(),
      }),
    )
    .join('\n')
  writeFileSync(join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`), `${scaled}\n`, 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [
      cezarCli,
      'serve',
      '--repo',
      dataRoot,
      '--port',
      String(port),
      '--no-open',
    ],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

const DOCK = '[data-slot="agents-dock"]'
const ROW = '[data-slot="agent-item"]'

/** The dock starts COLLAPSED (a quiet odometer) — expand it before reading rows. */
function expandDock(): void {
  browser.waitForFunction(`document.querySelector('${DOCK}') !== null`)
  if (browser.evaluate(`document.querySelector('${DOCK}').dataset.state`) === 'collapsed') {
    browser.click(`${DOCK} button[aria-expanded]`)
  }
  browser.waitForFunction(`document.querySelector('${DOCK}').dataset.state === 'open'`)
}

describe('the Agents dock against a replayed fan-out', () => {
  it('docks both sub-agents with odometer, type badge, activity and tool count', () => {
    browser.goto(`${baseUrl}/tasks/${RUN_ID}`)
    // The dock mounts only once the replay has produced the fan-out — collapsed by default.
    expandDock()
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 2`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="agents-count"]')?.textContent.includes('2/2')`,
    )

    const rows = JSON.parse(
      browser.evaluate(`JSON.stringify([...document.querySelectorAll('${ROW}')].map((row) => ({
        text: row.textContent,
        type: row.querySelector('[data-slot="agent-type"]')?.textContent,
        tools: row.querySelector('[data-slot="agent-tools"]')?.textContent,
      })))`) as string,
    ) as Array<{ text: string; type?: string; tools?: string }>

    expect(rows[0]!.text).toContain('Audit the auth flow')
    expect(rows[0]!.type).toBe('general-purpose')
    expect(rows[0]!.tools).toBe('36 tools')
    expect(rows[1]!.text).toContain('Review the store layer')
    expect(rows[1]!.type).toBe('code-reviewer')
    expect(rows[1]!.tools).toBe('1 tool')

    // The transcript keeps its Task cards — the dock is ADDITIVE (spec Q4), not a relocation.
    expect(browser.evaluate(`document.querySelectorAll('[data-slot="tool-card"]').length > 0`)).toBe(true)

    browser.screenshot(join(artifactsDir, 'agents-dock-expanded.png'))
  }, 120_000)

  it('a row opens the drill-down sheet with that agent’s output and nobody else’s', () => {
    browser.goto(`${baseUrl}/tasks/${RUN_ID}`)
    expandDock()
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 2`)

    // The second agent's row — a real dialog-opening button.
    browser.click(`${ROW}:nth-of-type(2) button`)
    browser.waitForFunction(`document.querySelector('[data-slot="subagent-sheet"]') !== null`)

    const sheet = browser.evaluate(
      `document.querySelector('[data-slot="subagent-sheet"]').textContent`,
    ) as string
    expect(sheet).toContain('Review the store layer')
    expect(sheet).toContain('code-reviewer')
    // Its own tool call…
    expect(sheet).toContain('runs/store')
    // …and not the FIRST agent's, which is the whole point of a per-agent panel.
    expect(sheet).not.toContain('src/middleware.ts')

    // The panel slides in over ~500ms; shooting immediately captures it mid-flight, which
    // makes the QA artifact look like a rendering bug. Wait for it to reach its rest position.
    browser.waitForFunction(
      `Math.abs(document.querySelector('[data-slot="subagent-sheet"]').getBoundingClientRect().right - window.innerWidth) < 2`,
    )
    browser.screenshot(join(artifactsDir, 'agents-dock-sheet.png'))

    // Esc returns to the thread without disturbing the dock.
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="subagent-sheet"]') === null`)
    expect(browser.evaluate(`document.querySelector('${DOCK}') !== null`)).toBe(true)
  }, 120_000)

  it('summarizes a busy agent instead of streaming every card into the sheet', () => {
    // The drill-down became a SUMMARY panel: a heavy child stream (34 seeded Bash checks)
    // folds into activity counts rather than 34 cards — the raw transcript stays in the
    // thread's own Task cards.
    browser.goto(`${baseUrl}/tasks/${RUN_ID}`)
    expandDock()
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 2`)
    browser.click(`${ROW}:nth-of-type(1) button`)
    browser.waitForFunction(`document.querySelector('[data-slot="subagent-sheet"]') !== null`)

    const sheet = browser.evaluate(
      `document.querySelector('[data-slot="subagent-sheet"]').textContent`,
    ) as string
    expect(sheet).toContain('Audit the auth flow')
    expect(sheet).toContain('general-purpose')
    expect(sheet).toContain('tool calls')
    // Not one card per child — the sheet is a digest: the heavy 34-check stream folds into
    // the activity counts, with at most a handful of representative cards.
    expect(
      browser.evaluate(`document.querySelectorAll('[data-slot="subagent-sheet"] [data-slot="tool-card"]').length`),
    ).toBeLessThan(10)

    browser.screenshot(join(artifactsDir, 'agents-dock-long-transcript.png'))
    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('[data-slot="subagent-sheet"]') === null`)
  }, 120_000)

  it('collapses to a one-line odometer', () => {
    browser.goto(`${baseUrl}/tasks/${RUN_ID}`)
    expandDock()
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 2`)

    browser.click(`${DOCK} > button`)
    browser.waitForFunction(`document.querySelectorAll('${ROW}').length === 0`)
    expect(browser.evaluate(`document.querySelector('[data-slot="agents-count"]').textContent`)).toContain('2/2')
    expect(
      browser.evaluate(`document.querySelector('${DOCK} > button').getAttribute('aria-expanded')`),
    ).toBe('false')

    browser.screenshot(join(artifactsDir, 'agents-dock-collapsed.png'))
  }, 120_000)
})
