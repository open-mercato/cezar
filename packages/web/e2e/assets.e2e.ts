import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The Assets view (spec 2026-10-22-html-artifacts-and-impact, step 6) against a LIVE dry run: the
 * mock agent writes `demo.html` into the run's artifacts folder, the server lists and serves it
 * behind its CSP sandbox, and the cockpit frames it. The page itself is opaque-origin, so the frame
 * is asserted from outside — its title, its sandbox, and that it loaded.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-assets-${process.pid}`

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
  throw new Error(`cezar e2e: the assets server never answered at ${url}`)
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as { status: string }
    if (wanted.includes(record.status)) return record.status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string
let runId: string

const scoped = (path: string) => `/p/${bootProject}${path}`
const SPEC = '.ai/specs/2026-10-23-demo.md'

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-assets-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# assets e2e fixture repo\n', 'utf8')
  // A committed spec, so Git → Files offers Assess impact on it (step 11).
  mkdirSync(join(dataRoot, '.ai/specs'), { recursive: true })
  writeFileSync(join(dataRoot, SPEC), '# Demo spec\n\nAdd a thing.\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Publish a page.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id
  // The first turn has ended by `waiting`, and the turn-end rescan has listed the mock's page.
  await waitForStatus(baseUrl, runId, ['waiting', 'review', 'done'])

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  // The run is still live (parked at `waiting`): let the server exit before its files go.
  if (server && server.exitCode === null) {
    const exited = new Promise((done) => server.once('exit', done))
    server.kill()
    await exited
  }
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5 })
})

describe('the Assets view against a live dry run', () => {
  it('lists the page the mock agent published', async () => {
    const listing = (await (await fetch(`${baseUrl}/api/v1/runs/${runId}/artifacts`)).json()) as {
      artifacts: { name: string; kind: string; title?: string }[]
    }
    expect(listing.artifacts).toContainEqual(expect.objectContaining({ name: 'demo.html', kind: 'html', title: 'Dry-run demo report' }))
  })

  it('frames the page sandboxed — no allow-same-origin — under its title', () => {
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/assets`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="assets-frame"]') !== null`)
    expect(browser.evaluate(`document.querySelector('[data-slot="assets-frame"]').getAttribute('title')`)).toBe(
      'Dry-run demo report',
    )
    const sandbox = String(browser.evaluate(`document.querySelector('[data-slot="assets-frame"]').getAttribute('sandbox')`))
    expect(sandbox.split(/\s+/).sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-scripts'])
    expect(browser.text('[data-action="assets-switcher"]')).toContain('Dry-run demo report')
    expect(browser.text('[data-fixed="assets"]')).toContain('1')
    // The frame takes the rest of the column, not an iframe's default 150px.
    expect(browser.evaluate(`document.querySelector('[data-slot="assets-frame"]').getBoundingClientRect().height > 400`)).toBe(true)
    browser.screenshot(`${artifactsDir}/assets-desktop.png`)
  })

  it('the chat shows the published page as a card that opens it', () => {
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/chat`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="thread-artifact-card"][data-artifact="demo.html"]') !== null`)
    browser.click('[data-slot="thread-artifact-card"][data-artifact="demo.html"] [data-action="open-artifact"]')
    browser.waitForFunction(`location.pathname.endsWith('/assets/demo.html')`)
    browser.waitForFunction(`document.querySelector('[data-slot="assets-frame"]') !== null`)
  })
})

describe('Assess impact on a spec against a live dry run (step 11)', () => {
  it('POST /impact starts a run whose report the Files header then opens', async () => {
    const started = await fetch(`${baseUrl}/api/v1/impact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: { kind: 'spec', path: SPEC } }),
    })
    expect(started.status).toBe(201)
    const { runId: impactRun } = (await started.json()) as { runId: string }
    // The dry-run mock writes the demo review.json; the backstop renders impact.html at turn end.
    let names: string[] = []
    for (let attempt = 0; attempt < 120 && !names.includes('impact.html'); attempt += 1) {
      await new Promise((r) => setTimeout(r, 500))
      const answer = (await (await fetch(`${baseUrl}/api/v1/artifacts?subject=${encodeURIComponent(`spec:${SPEC}`)}`)).json()) as {
        run: { id: string } | null
        artifacts: { name: string }[]
      }
      if (answer.run?.id === impactRun) names = answer.artifacts.map((artifact) => artifact.name)
    }
    expect(names).toContain('impact.html')
    await waitForStatus(baseUrl, impactRun, ['waiting', 'review', 'done'])

    browser.goto(`${baseUrl}${scoped(`/git/files/${SPEC}`)}`)
    browser.waitForFunction(`document.querySelector('[data-action="impact-open"]') !== null`)
    expect(browser.text('[data-slot="impact-meta"]')).toMatch(/ago/)
    browser.screenshot(`${artifactsDir}/impact-files-header.png`)
    browser.click('[data-action="impact-open"]')
    browser.waitForFunction(`location.pathname.endsWith('/tasks/${impactRun}/assets/impact.html')`)
    browser.waitForFunction(`document.querySelector('[data-slot="assets-frame"]') !== null`)
  }, 120_000)
})
