import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * In-task drafts (#939) end-to-end: the exact loop the feature exists for — type a reply to one
 * task, glance at another, come back, and find the message still there.
 *
 * Against a real `cezar` (CEZ_DRY_RUN=1) on a real tmp repo, so the round trip goes through the
 * real routes and the real files under `.ai/cezar/drafts/`. Two runs, because the bug this fixes
 * only appears when there is somewhere else to go.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-drafts-${process.pid}`

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
  throw new Error(`cezar e2e: the drafts server never answered at ${url}`)
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as { status: string }
    if (wanted.includes(record.status)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached "${wanted.join('/')}"`)
}

async function startRun(url: string, task: string): Promise<string> {
  const created = (await (
    await fetch(`${url}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  await waitForStatus(url, created.id, ['waiting'])
  return created.id
}

/** Poll the draft store from the TEST process — the honest "it reached the server" check. */
async function waitForDraft(url: string, id: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const body = (await (await fetch(`${url}/api/v1/runs/${id}/drafts`)).json()) as {
      surfaces?: Record<string, { text?: string }>
    }
    if (body.surfaces?.composer?.text === expected) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: run ${id} never stored the composer draft`)
}

const DRAFT = 'Actually — check the retry path before you touch the parser.'

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let taskA: string
let taskB: string

const composer = '[data-slot="composer"] textarea'

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-drafts-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# drafts e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  // Sequential: `maxParallel` is 1 by default, so a second concurrent run would sit queued.
  taskA = await startRun(baseUrl, 'The task I will be replying to.')
  taskB = await startRun(baseUrl, 'The task I glance at mid-sentence.')

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 240_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('a half-written reply survives leaving the task', () => {
  it('type into task A, open task B, come back — the text is still there', async () => {
    browser.goto(`${baseUrl}/tasks/${taskA}`)
    browser.waitForFunction(`document.querySelector('${composer}') !== null`)

    browser.click(composer)
    browser.fill(composer, DRAFT)
    // The write is debounced, so wait for the SERVER to hold it — asked from the test process,
    // which is also the proof it really left the browser.
    await waitForDraft(baseUrl, taskA, DRAFT)

    // Off to the other task — the composer there is its own, and empty.
    browser.goto(`${baseUrl}/tasks/${taskB}`)
    browser.waitForFunction(`document.querySelector('${composer}') !== null`)
    browser.waitForFunction(`document.querySelector('${composer}').value === ''`)

    // …and back.
    browser.goto(`${baseUrl}/tasks/${taskA}`)
    browser.waitForFunction(`document.querySelector('${composer}')?.value === ${JSON.stringify(DRAFT)}`)
    expect(browser.evaluate(`document.querySelector('${composer}').value`)).toBe(DRAFT)
    browser.screenshot(`${artifactsDir}/thread-draft-restored.png`)
  })

  it('sending it clears the draft — the next visit starts empty', async () => {
    browser.click('[aria-label="Send"]')
    browser.waitForFunction(`document.querySelector('${composer}').value === ''`)

    browser.goto(`${baseUrl}/tasks/${taskB}`)
    browser.waitForFunction(`document.querySelector('${composer}') !== null`)
    browser.goto(`${baseUrl}/tasks/${taskA}`)
    browser.waitForFunction(`document.querySelector('${composer}') !== null`)
    expect(browser.evaluate(`document.querySelector('${composer}').value`)).toBe('')
    const after = (await (await fetch(`${baseUrl}/api/v1/runs/${taskA}/drafts`)).json()) as {
      surfaces: Record<string, unknown>
    }
    expect(after.surfaces.composer).toBeUndefined()
  })
})
