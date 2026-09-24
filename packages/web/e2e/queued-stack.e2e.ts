import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli } from './agent-browser'

/**
 * Stacking, editing and removing a queued run's prompt (#472), end-to-end against a LIVE
 * dry-run cezar — the one state the cockpit used to forbid editing in.
 *
 * The queue is forced with `{"resources":{"maxParallel":1}}` in the throwaway
 * workspace's `CEZ_HOME/config.json`, and the slot is held by a `mock:slow` run
 * (~25 s turn). That
 * matters: a `waiting` run does NOT hold a slot (#347), so parking the first run would
 * free the queue immediately and there would be nothing queued to test.
 *
 * `config.json` is optional user-owned state with a working default, so a *test* pinning
 * it does not make the feature configuration.
 *
 * What this proves that the unit tests cannot: the composer is really enabled on a queued
 * run in a real browser, the affordances really mutate the record over HTTP, and the
 * amended prompt is really what the backend receives when the run finally starts.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-queued-stack-${process.pid}`

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
  throw new Error(`cezar e2e: the queued-stack server never answered at ${url}`)
}

async function getRun(url: string, id: string): Promise<{ status: string; task: string; queuedMessages?: Array<{ id: string; text: string }> }> {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/v1/runs/${id}`)
      if (!response.ok) throw new Error(`GET run answered ${response.status}`)
      return (await response.json()) as {
        status: string
        task: string
        queuedMessages?: Array<{ id: string; text: string }>
      }
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw lastError
}

async function waitForStatus(url: string, id: string, wanted: string[], tries = 160): Promise<string> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const { status } = await getRun(url, id)
    if (wanted.includes(status)) return status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

const startRun = async (url: string, task: string): Promise<string> => {
  const created = (await (
    await fetch(`${url}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  return created.id
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let queuedId: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-queued-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# queued-stack e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // One workspace-wide agent slot, so the second run demonstrably waits in the queue.
  // CEZ_HOME keeps this test isolated from the developer's real workspace config.
  const cezHome = join(dataRoot, '.cez-home')
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(
    join(cezHome, 'config.json'),
    JSON.stringify({ resources: { maxParallel: 1 } }),
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: cezHome }, stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  // Hold the only slot with a slow turn, then queue the run under test behind it.
  const blockerId = await startRun(baseUrl, 'mock:slow occupy the only agent slot')
  await waitForStatus(baseUrl, blockerId, ['running'])
  queuedId = await startRun(baseUrl, 'mock:done the original prompt')
  await waitForStatus(baseUrl, queuedId, ['queued'])

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/tasks/${queuedId}`)
  browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('a queued run’s prompt is amendable (#472)', () => {
  it('queued state: the composer is ENABLED with the queue placeholder and hint', () => {
    const composer = browser.evaluate(`(() => {
      const textarea = document.querySelector('[data-slot="composer"] textarea')
      return { disabled: textarea.disabled, placeholder: textarea.placeholder }
    })()`) as { disabled: boolean; placeholder: string }

    expect(composer.disabled).toBe(false)
    expect(composer.placeholder).toBe('Add to the prompt — sent when the run starts…')
    expect(browser.text('[data-slot="queued-hint"]')).toContain(
      'folded into the prompt before the run starts',
    )
    browser.screenshot(`${artifactsDir}/queued-composer-enabled.png`)
  })

  it('stacks a message onto the queued run and renders it as a bubble', async () => {
    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', 'also update the changelog')
    browser.click('[data-slot="composer"] [aria-label="Send"]')

    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`,
    )
    const bubbles = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="user-bubble"]')].map((b) => b.textContent)`,
    ) as string[]
    expect(bubbles[0]).toContain('the original prompt')
    expect(bubbles[1]).toContain('also update the changelog')

    // …and it really landed on the record, not just in the DOM.
    const record = await getRun(baseUrl, queuedId)
    expect(record.queuedMessages?.map((m) => m.text)).toEqual(['also update the changelog'])
    browser.screenshot(`${artifactsDir}/queued-stacked-message.png`)
  })

  it('edits the stacked message in place', async () => {
    browser.click('[aria-label="Remove message"], [aria-label="Edit message"]')
    browser.waitForFunction(`document.querySelector('[aria-label="Edit the message"]') !== null`)
    browser.fill('[aria-label="Edit the message"]', 'also update the changelog and the README')
    browser.screenshot(`${artifactsDir}/queued-editing.png`)
    browser.click('[data-slot="user-bubble"][data-editing="true"] button:last-of-type')

    browser.waitForFunction(
      `document.body.textContent.includes('also update the changelog and the README')`,
    )
    const record = await getRun(baseUrl, queuedId)
    expect(record.queuedMessages?.map((m) => m.text)).toEqual([
      'also update the changelog and the README',
    ])
  })

  it('removes the stacked message', async () => {
    browser.click('[aria-label="Remove message"]')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length === 1`)

    const record = await getRun(baseUrl, queuedId)
    expect(record.queuedMessages ?? []).toEqual([])
  })

  /**
   * The whole point: whatever is stacked when the slot frees must survive into the run.
   *
   * Delivery of the folded `{{task}}` to the backend is asserted at the engine level in
   * `src/workflows/run.test.ts`, which reads the mock's own record of the prompt it was
   * handed. Here the browser proves the UI half: the amendment survives the transition, the
   * record still holds the prompt and its stack SEPARATELY (hydration is read-only, so the
   * prompt never absorbs its stack and cannot compound across restarts), and the thread
   * keeps showing exactly one bubble per authored message once the run is under way.
   *
   * NB: never `await fetch(...).text()` on `/api/v1/runs/:id/events` — it is an SSE stream, so
   * the promise never settles and the test dies on its timeout instead of failing.
   */
  it('keeps the amendment when the run finally starts, and goes read-only', async () => {
    // Re-stack, so there is something to deliver.
    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', 'STACKEDFINAL check the docs too')
    browser.click('[data-slot="composer"] [aria-label="Send"]')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)

    // The blocker's slow turn ends (~25 s), the queue drains, and this run executes.
    await waitForStatus(baseUrl, queuedId, ['done', 'review', 'failed'], 240)

    const record = await getRun(baseUrl, queuedId)
    expect(record.task).toBe('mock:done the original prompt')
    expect(record.queuedMessages?.map((m) => m.text)).toEqual(['STACKEDFINAL check the docs too'])

    // The thread still shows one bubble per authored message, and the affordances are gone
    // now that the stack has become history.
    browser.goto(`${baseUrl}/tasks/${queuedId}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="user-bubble"]').length >= 2`)
    const bubbles = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="user-bubble"]')].map((b) => b.textContent)`,
    ) as string[]
    expect(bubbles[0]).toContain('the original prompt')
    expect(bubbles[1]).toContain('STACKEDFINAL check the docs too')
    expect(
      browser.evaluate(`document.querySelector('[aria-label="Remove message"]') === null`),
    ).toBe(true)
    browser.screenshot(`${artifactsDir}/queued-started-with-amended-prompt.png`)
  }, 180_000)
})
