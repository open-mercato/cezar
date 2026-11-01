import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv, getJson, stopFixtureServer } from './agent-browser'

/**
 * Managers (spec 2026-10-31-managers) against a LIVE dry-run server: the mock's scripted turn really
 * calls `cez-manager`, so the commands row, the session card and the approval card are what the
 * routes produced. Its own server, because the journey starts from "no manager yet" and managers
 * live in `CEZ_HOME`.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-manager-${process.pid}`
const NEW_BOX = 'textarea[aria-label="What should this manager do?"]'
const CHAT_BOX = '[data-route="manager-chat"] textarea'
const IDLE = `document.querySelector('[data-route="manager-chat"] [role="status"][aria-label="Working"]') === null`

type Manager = { id: string; name: string; unread: number; pendingActions: number; status: string }

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
  throw new Error(`cezar e2e: the manager server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let firstId: string

const managers = async () => (await getJson<{ managers: Manager[] }>(`${baseUrl}/api/v1/workspace/managers`)).managers

/** AgentBrowser clicks by CSS only; these are the controls a user finds by their text. */
const clickText = (text: string, within = 'body') =>
  browser.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${within} button, ${within} a`)})].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error('no control ' + ${JSON.stringify(text)}); b.click(); return true })()`)
const settled = () => {
  browser.waitForFunction(`document.querySelector('[data-slot="manager-assistant"]') !== null`)
  browser.waitForFunction(IDLE)
}
const send = (text: string) => {
  browser.fill(CHAT_BOX, text)
  browser.press('Enter')
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-manager-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# manager e2e fixture repo\n', 'utf8')
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
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server, dataRoot)
})

describe('Managers', () => {
  it('starts at the first-manager setup and creates one from a preset', async () => {
    browser.goto(`${baseUrl}/manager`)
    browser.waitForFunction(`document.querySelector('[data-route="manager-new"]') !== null`)
    expect(browser.text('h1')).toBe('Setup Your first manager')
    browser.screenshot(`${artifactsDir}/manager-first-run.png`)

    browser.click('[data-slot="manager-preset"]')
    browser.waitForFunction(`document.querySelector(${JSON.stringify(NEW_BOX)}).value.startsWith('Watch my repositories')`)
    browser.click('button[aria-label="Create manager"]')
    browser.waitForFunction(`document.querySelector('[data-route="manager-chat"]') !== null`)
    settled()
    browser.waitForFunction(`document.body.textContent.includes('Approve')`)

    const [manager] = await managers()
    firstId = manager!.id
    expect(manager!.name).toBe('Repository Watcher')
    expect(manager!.pendingActions).toBe(1)
    expect(browser.url()).toContain(`/manager/${firstId}`)
  }, 120_000)

  it('renders the turn: commands, a live session card, an approval card and a one-row composer', () => {
    expect(browser.text('[data-slot="manager-commands"]')).toMatch(/Ran \d+ commands?/)
    clickText('Ran ', '[data-slot="manager-commands"]')
    browser.waitForFunction(`document.querySelector('[data-slot="manager-commands"]').textContent.includes('cez-manager status')`)

    browser.waitForFunction(`document.querySelector('[data-slot="session-card"]')?.textContent.includes('Dry-run task') === true`)
    expect(browser.count('[data-slot="manager-action"][data-status="pending"]')).toBe(1)

    const height = browser.evaluate(`document.querySelector('[data-slot="composer-compact-row"]').getBoundingClientRect().height`)
    expect(height).toBeLessThan(60)
    expect(browser.count('[data-slot="composer-compact-row"] button[aria-label="Start dictation"]')).toBe(1)
    browser.screenshot(`${artifactsDir}/manager-chat.png`)
  }, 60_000)

  it('goes into the task from its card and back to the manager', () => {
    browser.click('[data-slot="session-card"]')
    browser.waitForFunction(`location.pathname.includes('/tasks/')`)
    browser.waitForFunction(`document.body.textContent.includes('Back to Watch my repositories')`)
    clickText('Back to Watch my repositories')
    browser.waitForFunction(`document.querySelector('[data-route="manager-chat"]') !== null`)
    expect(browser.url()).toContain(`/manager/${firstId}`)
  }, 60_000)

  it('only merges on approval, and a rejection merges nothing', async () => {
    clickText('Approve', '[data-slot="manager-action"]')
    browser.waitForFunction(`document.querySelector('[data-slot="manager-action"]').dataset.status === 'done'`)
    expect(browser.text('[data-slot="manager-action"]')).toContain('Merged #128')

    send('please merge it')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="manager-action"]').length === 2`)
    settled()
    clickText('Reject', '[data-slot="manager-action"][data-status="pending"]')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="manager-action"]')[1].dataset.status === 'rejected'`)
    expect((await managers())[0]!.pendingActions).toBe(0)
  }, 60_000)

  it('stops a turn and runs what was queued behind it', async () => {
    send('stop me')
    browser.waitForFunction(`document.querySelector('[data-slot="composer-stop"]') !== null`)
    // Past the guard that keeps the second click of a double-click on Send from landing here.
    await new Promise((r) => setTimeout(r, 700))
    browser.click('[data-slot="composer-stop"]')
    browser.waitForFunction(`document.body.textContent.includes('Response stopped.')`)
    browser.waitForFunction(IDLE)

    send('first')
    send('second')
    browser.waitForFunction(`[...document.querySelectorAll('[data-slot="manager-user"]')].map((el) => el.textContent).includes('second')`)
    browser.waitForFunction(IDLE)
    const rows = browser.evaluate(`[...document.querySelectorAll('[data-slot="manager-user"]')].length`)
    expect(rows).toBeGreaterThanOrEqual(4)
  }, 90_000)

  it('marks another manager unread after a check, and reading it clears the dot', async () => {
    clickText('New manager', '[data-slot="sidebar"]')
    browser.waitForFunction(`document.querySelector('[data-route="manager-new"]') !== null`)
    expect(browser.text('h1')).toBe('New manager')
    browser.fill(NEW_BOX, 'Second opinion on releases')
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('[data-route="manager-chat"]') !== null && !location.pathname.includes(${JSON.stringify(firstId)})`)
    settled()
    expect(browser.text('h1')).toBe('Second opinion on releases')

    const checked = await fetch(`${baseUrl}/api/v1/workspace/managers/${firstId}/check`, { method: 'POST', headers: { connection: 'close' } })
    expect(checked.status).toBe(200)
    const row = `a[data-slot="manager-row"][href="/manager/${firstId}"]`
    browser.waitForFunction(`document.querySelector(${JSON.stringify(`${row} [data-slot="manager-unread"]`)}) !== null`)

    browser.click(row)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(`${row} [data-slot="manager-unread"]`)}) === null`)
  }, 90_000)

  it('switches between Tasks and Manager from the URL alone', () => {
    clickText('Tasks', '[data-slot="mode-switch"]')
    browser.waitForFunction(`location.pathname.startsWith('/p/')`)
    expect(browser.count('[data-slot="manager-row"]')).toBe(0)
    clickText('Manager', '[data-slot="sidebar"]')
    browser.waitForFunction(`document.querySelector('[data-route="manager-chat"]') !== null`)
    expect(browser.count('[data-slot="manager-row"]')).toBe(2)
  }, 60_000)

  it('renames from the settings menu, and deleting the last manager returns to first-run', async () => {
    browser.click('[data-slot="manager-settings"]')
    browser.waitForFunction(`document.querySelector('[data-slot="manager-settings-menu"]') !== null`)
    browser.screenshot(`${artifactsDir}/manager-settings.png`)
    clickText('Persona', '[data-slot="manager-settings-menu"]')
    browser.waitForFunction(`document.querySelector('[role="dialog"] input') !== null`)
    browser.fill('[role="dialog"] input', 'Global Manager')
    clickText('Save', '[role="dialog"]')
    browser.waitForFunction(`document.querySelector('h1').textContent === 'Global Manager'`)

    for (const expected of [1, 0]) {
      browser.click('[data-slot="manager-settings"]')
      browser.waitForFunction(`document.querySelector('[data-slot="manager-settings-menu"]') !== null`)
      clickText('Delete', '[data-slot="manager-settings-menu"]')
      browser.waitForFunction(`document.querySelector('[role="alertdialog"]') !== null`)
      clickText('Delete', '[role="alertdialog"]')
      browser.waitForFunction(`document.querySelectorAll('[data-slot="manager-row"]').length === ${expected}`)
    }
    browser.waitForFunction(`document.querySelector('[data-route="manager-new"]') !== null`)
    expect(browser.text('h1')).toBe('Setup Your first manager')
    expect(await managers()).toEqual([])
  }, 90_000)
})
