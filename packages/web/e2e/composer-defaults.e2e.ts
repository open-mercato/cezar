import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

const sessionId = `e2e-composer-defaults-${process.pid}`

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

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
      // The fixture server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`cezar e2e: the composer-defaults server never answered at ${url}`)
}

async function putDefaults(autonomous: boolean | null, worktree: boolean | null): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ composerDefaults: { autonomous, worktree } }),
  })
  if (!response.ok) throw new Error(`workspace config update failed: ${response.status}`)
}

function choose(selector: string, value: string): void {
  browser.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLSelectElement)) throw new Error('select not found')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-composer-defaults-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# composer defaults fixture\n', 'utf8')
  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/skills/interactive-review.md'),
    '---\ndescription: Review a proposal with the user\ninteractive: true\n---\n\nAsk questions before writing the review.\n',
    'utf8',
  )
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
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('configurable composer run defaults', () => {
  it('covers cold, interactive, and persisted workspace defaults', async () => {
    await putDefaults(null, null)
    try {
      browser.goto(`${baseUrl}/p/${bootProject}/new`)
      // A cold composer picks nothing: the source pill is the empty invitation, and the run it
      // would start is the plain built-in quick-task. Wait on the LABEL, not on the kind — an
      // unpicked pill reports `none` while it is still showing its loading ellipsis.
      browser.waitForFunction(
        `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('Skill')`,
      )
      expect(browser.evaluate(
        `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind`,
      )).toBe('none')
      expect(browser.evaluate(
        `document.querySelector('[data-slot="worktree-toggle"]')?.getAttribute('aria-checked')`,
      )).toBe('true')
      expect(browser.evaluate(
        `document.querySelector('[data-slot="autonomous-toggle"]')?.getAttribute('aria-checked')`,
      )).toBe('false')

      browser.click('[data-slot="source-pill"]')
      browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
      browser.click('[data-slot="source-option"][data-source-ref="interactive-review"]')
      browser.waitForFunction(
        `document.querySelector('[data-slot="interactive-skill-hint"]') !== null`,
      )
      // The popover is dismissed by the pick, but its exit animation still covers the chip row
      // for a frame or two — and the toggles below are exactly what this spec clicks next.
      browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') === null`)
      for (const slot of ['worktree-toggle', 'autonomous-toggle']) {
        expect(browser.evaluate(
          `document.querySelector('[data-slot="${slot}"]')?.getAttribute('aria-checked')`,
        )).toBe('false')
        expect(browser.evaluate(
          `document.querySelector('[data-slot="${slot}"]')?.disabled`,
        )).toBe(false)
        browser.click(`[data-slot="${slot}"]`)
        expect(browser.evaluate(
          `document.querySelector('[data-slot="${slot}"]')?.getAttribute('aria-checked')`,
        )).toBe('true')
      }

      browser.goto(`${baseUrl}/settings/global/resources`)
      browser.waitForFunction(
        `document.querySelector('[data-slot="resources-composer-defaults"]') !== null`,
      )
      choose('[aria-label="Autonomous by default"]', 'on')
      browser.waitForFunction(
        `document.querySelector('[aria-label="Autonomous by default"]')?.value === 'on'`,
      )
      browser.goto(`${baseUrl}/settings/global/resources`)
      browser.waitForFunction(
        `document.querySelector('[aria-label="Autonomous by default"]')?.value === 'on'`,
      )
      const config = (await (await fetch(`${baseUrl}/api/v1/workspace/config`)).json()) as {
        composerDefaults: { autonomous: boolean | null }
      }
      expect(config.composerDefaults.autonomous).toBe(true)
    } finally {
      await putDefaults(null, null)
    }
  })
})
