import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let browser: AgentBrowser, server: ChildProcess, root: string, url: string, project: string
async function availablePort(): Promise<number> {
  return new Promise((done, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => done(p)) }) })
}
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${url}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const click = (label: string) => browser.evaluate(`(() => { const el = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); if (!el || el.disabled) throw Error('button unavailable'); el.click(); return true })()`)
const fill = (label: string, value: string) => {
  const id = browser.evaluate(`(() => { const el = [...document.querySelectorAll('label')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); return el?.htmlFor })()`)
  browser.fill(`[id=${JSON.stringify(id)}]`, value)
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-e2e-webhooks-')); execFileSync('git', ['init', '-q'], { cwd: root })
  const port = await availablePort(); url = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root, { CEZ_WEBHOOKS: '1' }), stdio: 'ignore' })
  for (let i = 0; i < 80; i++) { try { if ((await api('/health')).ok) break } catch { /* boot */ } await new Promise(r => setTimeout(r, 250)) }
  project = await bootProjectId(url); browser = AgentBrowser.open(`e2e-webhooks-${process.pid}`); browser.setViewport(1440, 1000)
}, 90000)
afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) { server.kill(); await new Promise<void>(done => { if (server.exitCode !== null) return done(); server.once('exit', () => done()); setTimeout(done, 5000).unref() }) }
  if (root) rmSync(root, { recursive: true, force: true })
})
describe('project lifecycle webhook setup in the cockpit', () => {
  it('adds, tests, activates and records a dry-run task delivery, then retains deleted history', async () => {
    browser.goto(`${url}/p/${project}/settings/webhooks`)
    browser.waitForFunction("document.body.textContent.includes('No receivers yet')")
    click('Add receiver'); browser.waitForFunction("document.querySelector('[role=dialog] input') !== null")
    fill('Name', 'E2E receiver'); fill('Receiver URL', 'https://receiver.invalid/no-network')
    click('Save receiver'); browser.waitForFunction("document.body.textContent.includes('Save your signing key')")
    // Never serialize or screenshot the actual one-time key.
    click('I’ve saved the key'); browser.waitForFunction("document.querySelector('[role=dialog]') === null")
    browser.waitForFunction("document.activeElement?.textContent.trim() === 'Add receiver'")
    click('Send test')
    try { browser.waitForFunction("document.body.textContent.includes('Last test: passed')") }
    catch (cause) { throw new Error(`Test delivery did not update the view: ${JSON.stringify(await (await api('/webhooks')).json())}; ${browser.evaluate('document.body.innerText')}`, { cause }) }
    click('Activate'); browser.waitForFunction("document.body.textContent.includes('Activate E2E receiver?')")
    click('Confirm'); browser.waitForFunction("document.querySelector('article h3')?.textContent.includes('Active') && !document.querySelector('[role=dialog]')")
    const response = await api('/runs', { task: 'mock:done Dry-run webhook completion fixture', workflow: 'quick-task', worktree: false })
    expect(response.status).toBe(201)
    const created = await response.json() as { id: string }
    let delivered = false
    for (let i = 0; i < 100; i++) {
      const list = await (await api('/webhooks')).json() as { receivers: { id: string }[] }
      const page = await (await api(`/webhooks/${list.receivers[0]!.id}/deliveries`)).json() as { items: { taskId?: string; status: string }[] }
      if (page.items.some(item => item.taskId === created.id && item.status === 'delivered')) { delivered = true; break }
      await new Promise(r => setTimeout(r, 300))
    }
    if (!delivered) { const run = await (await api(`/runs/${created.id}`)).json() as { status?: string; error?: string }; throw new Error(`No task delivery: status=${run.status}, error=${run.error ?? 'none'}`) }
    click('History'); browser.waitForFunction("document.querySelector('[role=dialog]')?.textContent.includes('Delivered')")
    // The cockpit's live-status pulse is infinite; only the dialog transition
    // must settle before capture and Escape. Keep the delivered assertion above.
    browser.waitForFunction("[...document.querySelector('[role=dialog]').getAnimations({ subtree: true })].filter(animation => animation.effect?.getTiming().iterations !== Infinity).every(animation => animation.playState !== 'running')")
    browser.screenshot(`${artifacts}/webhooks-history-desktop.png`); browser.press('Escape')
    browser.waitForFunction("document.querySelector('[role=dialog]') === null")
    for (const theme of ['light', 'dark']) {
      browser.evaluate(`document.documentElement.classList.toggle("light", ${theme === 'light'})`)
      browser.setViewport(390, 844)
      expect(browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
      browser.screenshot(`${artifacts}/webhooks-mobile-${theme}.png`)
    }
    browser.setViewport(1440, 1000); browser.click('button[aria-label^="More actions for"]'); browser.waitForFunction("document.querySelector('[role=menuitem]') !== null")
    browser.evaluate("[...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === 'Delete').click()")
    browser.waitForFunction("document.body.textContent.includes('Delete E2E receiver?')"); click('Delete')
    browser.waitForFunction("document.body.textContent.includes('No receivers yet')")
    expect(await (await api('/webhooks/history')).json()).toMatchObject({ total: 1 })
  }, 120000)
})
