import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import { largeThreadEvents } from './fixtures/make-large-thread'
import record from './fixtures/thread-run.record.json'

/**
 * "Your messages" (spec 2026-11-17-my-message-navigation) in a real browser: on a transcript
 * longer than one history page, ▲ steps through the user's own messages and highlights each,
 * and the list reaches the opening task, which lives in a page that is not loaded yet.
 */

const sessionId = `e2e-my-messages-${process.pid}`
/** ~2.5 history pages: the opening task is two pages back from the tail. */
const TURNS = 200
const RUN_ID = 'aaaaaaaa-2222-4333-8444-bbbbbbbbdddd'
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

const MAIN = `document.querySelector('[data-slot="thread-rows"]').closest('[data-slot="main"]')`
const PILL = '[data-slot="my-messages"]'
/** The message a jump landed on: focused and ringed. */
const LANDED = `(() => { const el = document.activeElement; return el && el.matches('[data-slot="user-bubble"][data-jump-highlight]') ? el.textContent : '' })()`
const landedPass = () => Number(/pass (\d+)/.exec(String(browser.evaluate(LANDED)))?.[1] ?? NaN)

/** Scroll away from the tail the way a reader does: the wheel unpins, the write moves (thread-scroll.e2e.ts). */
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

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-my-messages-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([RUN], null, 2), 'utf8')
  writeFileSync(
    join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`),
    largeThreadEvents(TURNS).map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  )
  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  try {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* the OS reaps it */
  }
})

describe('jumping between your own messages', () => {
  it('shows nothing at the tail, and the pill once the reader scrolls up', () => {
    browser.goto(`${baseUrl}/p/${bootProject}/tasks/${RUN_ID}`)
    browser.waitForFunction(`document.body.textContent.includes('goal achieved — session closed')`)
    expect(browser.count(PILL)).toBe(0)
    parkAt('m.scrollHeight - m.clientHeight - 700')
    browser.waitForFunction(`document.querySelector('${PILL}') !== null`)
    // No numbers on the pill.
    expect(browser.text(PILL)).not.toMatch(/\d/)
  }, 90_000)

  it('▲ lands on the previous message of yours and highlights it; again walks further back', () => {
    browser.click('[data-slot="my-messages-prev"]')
    browser.waitForFunction(`${LANDED} !== ''`)
    const first = landedPass()
    expect(first).toBeGreaterThan(1)
    browser.click('[data-slot="my-messages-prev"]')
    browser.waitForFunction(`/pass (\\d+)/.test(${LANDED}) && Number(/pass (\\d+)/.exec(${LANDED})[1]) < ${first}`)
    expect(landedPass()).toBe(first - 1)
    // ▼ walks forward again.
    browser.click('[data-slot="my-messages-next"]')
    browser.waitForFunction(`Number(/pass (\\d+)/.exec(${LANDED})?.[1]) === ${first}`)
  }, 60_000)

  it('the list holds the whole run and pages back to the opening task', () => {
    browser.click('[data-slot="my-messages-list-button"]')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="my-messages-item"]').length === ${TURNS}`)
    // The message on screen is marked in the list.
    expect(browser.count('[data-slot="my-messages-item"][aria-current="true"]')).toBeGreaterThan(0)
    browser.waitForFunction(`document.activeElement?.getAttribute('role') === 'listbox'`)
    browser.press('Home')
    browser.press('Enter')
    browser.waitForFunction(`${LANDED}.includes('Walk the whole git history in passes.')`)
    browser.waitForFunction(`document.querySelector('[data-slot="my-messages-list"]') === null`)
  }, 90_000)

  it('Latest returns to the tail, where the pill goes away', () => {
    browser.click('[data-slot="my-messages-latest"]')
    browser.waitForFunction(`document.querySelector('${PILL}') === null`)
  }, 60_000)
})
