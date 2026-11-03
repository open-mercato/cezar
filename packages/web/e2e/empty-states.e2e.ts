import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, stopFixtureServer } from './agent-browser'

/**
 * The empty surfaces in a real browser: the first run on the overview (spec
 * 2026-10-26-first-run-onboarding, which replaced the old "No tasks yet" hero) and the
 * CenteredState 404 with its way back home.
 *
 * Same per-spec boot pattern as quick-list.e2e.ts, but over an EMPTY folder: a fresh data dir with
 * no `runs.json` and no `.git` is not a contrived fixture — it is exactly what `npx cezar-cli`
 * serves when started outside a repository, and the first-run page is the first thing a new user
 * sees. The store answers `[]`, honestly, and the dry-run agent counts as signed in.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')

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
  throw new Error(`cezar e2e: the empty-fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

const STATE = '[data-slot="centered-state"]'

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-empty-states-'))

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' }
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(`e2e-empty-states-${process.pid}`)
  browser.setViewport(1440, 900)
}, 90_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server, dataRoot)
})

describe('tasks overview — first run outside a repository', () => {
  beforeAll(() => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    // The first run is async: it renders only after /api/v1/runs and the provider status answer.
    browser.waitForFunction(`document.querySelector('[data-slot="first-run"]') !== null`)
  })

  it('replaces the empty state with the pick-a-project step, and offers Initialize git here', () => {
    expect(
      browser.evaluate(`document.querySelector('[data-slot="tasks-empty"]').dataset.emptyKind`)
    ).toBe('no-tasks')
    expect(
      browser.evaluate(`document.querySelector('[data-slot="tasks-empty"] [data-slot="first-run"]').dataset.firstRun`)
    ).toBe('pick-project')
    expect(browser.text(`[data-slot="first-run"] h2`)).toBe('Pick a project')
    // The rail: the agent step is behind (the dry-run agent is signed in), the project is current.
    expect(
      browser.evaluate(`[...document.querySelectorAll('[data-slot="step-rail"] [data-step]')].map((step) => step.dataset.step + ':' + step.dataset.state).join(' ')`)
    ).toBe('agent:done project:current task:next')
    expect(
      browser.evaluate(`[...document.querySelectorAll('[data-slot="first-run"] button')].some((button) => button.textContent.trim() === 'Initialize git here')`)
    ).toBe(true)
    // And no table pretending otherwise.
    expect(browser.count('[data-slot="task-table-row"]')).toBe(0)

    browser.screenshot(`${artifactsDir}/tasks-first-run-pick-project.png`)
  })
})

describe('the 404 route', () => {
  beforeAll(() => {
    browser.goto(`${baseUrl}${scoped('/definitely-not-a-route')}`)
    browser.waitForFunction(`document.querySelector('[data-route="not-found"]') !== null`)
  })

  it('renders the CenteredState 404', () => {
    expect(browser.count(`[data-route="not-found"] ${STATE}`)).toBe(1)
    expect(browser.text(`[data-route="not-found"] h1`)).toBe('Page not found')
    // A stub-level surface, not a hero: no backdrop here.
    expect(browser.count(`[data-route="not-found"] [data-slot="twinkle-backdrop"]`)).toBe(0)

    browser.screenshot(`${artifactsDir}/not-found.png`)
  })

  it('walks back to the tasks overview through the action', () => {
    browser.click(`[data-route="not-found"] a[href="${scoped('/')}"]`)
    browser.waitForFunction(`location.pathname === '${scoped('/')}'`)
    expect(browser.count('[data-route="tasks"]')).toBe(1)
  })
})
