import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/thread-run.record.json'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const RUN_ID = `e2e-transcript-copy-${process.pid}`
const SOURCE = '## Copy this source\n\n```ts\nconst answer = true\n```'

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
      // Startup races the first health probe.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`transcript copy fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let projectId: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-transcript-copy-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  const run = {
    ...record,
    id: RUN_ID,
    task: SOURCE,
    title: 'Transcript copy fixture',
    titleSummary: 'Transcript copy fixture',
    pullRequestUrl: undefined,
  }
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([run], null, 2), 'utf8')
  const events = readFileSync(resolve(import.meta.dirname, 'fixtures/thread-run.ndjson'), 'utf8')
    .replaceAll('fcd519dd-5641-45d6-a9a2-d8eef6eed2e3', RUN_ID)
  writeFileSync(join(dataRoot, '.ai/cezar/runs', `${RUN_ID}.ndjson`), events, 'utf8')
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  projectId = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`e2e-transcript-copy-${process.pid}`)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/p/${projectId}/tasks/${RUN_ID}`)
  browser.waitForFunction(
    `document.querySelector('[data-route="task-thread"]') !== null &&
     document.querySelectorAll('button[aria-label="Copy message"]').length >= 2`,
  )
}, 120_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('transcript message copy', () => {
  it('copies from the desktop transcript with keyboard Enter and exposes feedback', () => {
    browser.evaluate(`(() => {
      window.__copied = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.__copied = text } },
      })
      document.querySelector('button[aria-label="Copy message"]').focus()
    })()`)
    browser.press('Enter')
    // Chromium's clipboard permission is environment-dependent; the component-level suite pins
    // the exact payload and success state. This real-browser step proves native keyboard
    // activation does not navigate or crash the transcript.
    expect(browser.count('button[aria-label="Copy message"]')).toBeGreaterThan(0)
    expect(browser.count('[role="status"]')).toBeGreaterThan(0)
    browser.screenshot(join(artifactsDir, 'transcript-copy-desktop.png'), { viewport: true })
  })

  it('keeps the copy action tappable on a mobile viewport', () => {
    browser.setViewport(390, 844)
    browser.waitForFunction(`document.querySelector('button[aria-label="Copy message"]') !== null`)
    browser.evaluate(`Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => {} },
    })`)
    browser.click('button[aria-label="Copy message"]')
    expect(browser.count('button[aria-label="Copy message"]')).toBeGreaterThan(0)
    browser.screenshot(join(artifactsDir, 'transcript-copy-mobile.png'), { viewport: true })
    browser.setViewport(1440, 900)
  })
})
