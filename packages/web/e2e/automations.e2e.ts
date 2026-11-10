import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-automations-${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
const created: string[] = []
/** `capabilities.automations` — on by default since spec 2026-09-14; the shared environment
 *  boots the default, so the opted-out case runs only when it was booted with CEZ_AUTOMATIONS=0. */
let automationsAvailable = true

type Automation = { id: string; name: string; enabled: boolean; kind: string; nextRunAt?: string }

/** Every call closes its socket and retries once: undici reuses keep-alive sockets the server
 *  may have idled out between browser steps, which surfaces as a spurious ECONNRESET. */
const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const request = () => fetch(`${baseUrl}/api/v1${path}`, { ...init, headers: { connection: 'close', ...(init.headers ?? {}) } })
  try {
    return await request()
  } catch {
    return request()
  }
}
const listAutomations = async (): Promise<Automation[]> =>
  ((await (await api('/automations')).json()) as { automations: Automation[] }).automations

/** Click the first button whose visible text is exactly `label` — AgentBrowser clicks by CSS only. */
const clickButton = (label: string) =>
  browser.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) throw new Error('no button ' + ${JSON.stringify(label)}); b.click(); return true })()`)
const clickByAriaLabel = (label: string, within = 'body') =>
  browser.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(`${within} [aria-label="${label}"]`)}); if (!b) throw new Error('no control ' + ${JSON.stringify(label)}); b.click(); return true })()`)

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((response) => response.json())) as {
    capabilities: { automations: boolean }
  }
  automationsAvailable = health.capabilities.automations
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(async () => {
  browser?.close()
  for (const id of created) await api(`/automations/${id}`, { method: 'DELETE' })
})

describe('Automations', () => {
  // The opted-out shape, asserted in a real browser: nothing about automations is reachable or
  // advertised on a cockpit started with CEZ_AUTOMATIONS=0.
  it('is absent from the sidebar and refuses its API when opted out', async ({ skip }) => {
    skip(automationsAvailable, 'the shared environment runs the default (on); boot with CEZ_AUTOMATIONS=0 to exercise this')
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    expect(browser.text('[data-slot="sidebar"]')).not.toContain('Automations')

    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.body.textContent.includes('Automations are off')`)
    expect(browser.text('main')).toContain('CEZ_AUTOMATIONS=0')
    browser.screenshot(`${artifactsDir}/automations-disabled.png`)

    const refused = await api('/automations')
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS')
  }, 60_000)

  it('is in the sidebar by default, with the empty state and the New automation button', async ({ skip }) => {
    skip(!automationsAvailable, 'opted out')
    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null && document.querySelector('[data-route="automations"]') !== null`)
    expect(browser.text('[data-slot="sidebar"]')).toContain('Automations')
    browser.waitForFunction(`document.body.textContent.includes('New automation')`)
    browser.screenshot(`${artifactsDir}/automations-list-initial.png`)
  }, 60_000)

  it('creates a schedule from a template, runs it by hand, shows it in the log, the week view and the rail', async ({ skip }) => {
    skip(!automationsAvailable, 'opted out')
    const name = `E2E nightly ${process.pid}`

    // The editor, from a built-in template: the palette is open by default on /new.
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') !== null`)
    browser.screenshot(`${artifactsDir}/automations-editor-new-templates.png`)
    clickByAriaLabel('Use this: Nightly dependency bump')
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') === null && document.querySelector('[data-slot="editor-schedule"]') !== null`)
    browser.fill('[aria-label="Name"]', name)
    expect(browser.text('[data-slot="editor-cron"]')).toBe('0 4 * * *')
    expect(browser.count('[data-slot="next-runs-preview"]')).toBe(1)
    browser.screenshot(`${artifactsDir}/automations-editor-new-schedule.png`)
    clickButton('Save paused')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/automations'`)

    const automation = (await listAutomations()).find((item) => item.name === name)
    expect(automation).toMatchObject({ enabled: false, kind: 'schedule' })
    created.push(automation!.id)

    // The list row: paused, the schedule label, and the row's Run now.
    const rowSelector = `[data-slot="automation-row"][data-automation="${automation!.id}"]`
    browser.waitForFunction(`document.querySelector(${JSON.stringify(rowSelector)}) !== null`)
    expect(browser.text(rowSelector)).toContain('paused')
    expect(browser.text(rowSelector)).toContain('every day at 04:00')
    browser.screenshot(`${artifactsDir}/automations-list-paused.png`)

    clickByAriaLabel('Run now', rowSelector)
    // The run lands as an ordinary task with schedule provenance, and the row's last run fills in.
    browser.waitForFunction(`document.querySelector(${JSON.stringify(`${rowSelector} [data-slot="task-link"]`)}) !== null`)
    const runs = (await (await api('/runs')).json()) as Array<{ id: string; automationTrigger?: { automationId: string; trigger: string } }>
    const run = runs.find((item) => item.automationTrigger?.automationId === automation!.id)
    expect(run?.automationTrigger?.trigger).toBe('manual')
    expect((await listAutomations()).find((item) => item.id === automation!.id)?.enabled).toBe(false)

    // The log names the by-hand launch and links the task.
    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automation!.id}/log`)
    browser.waitForFunction(`document.querySelector('[data-slot="log-row"][data-result="manual"]') !== null`)
    expect(browser.text('[data-slot="log-row"][data-result="manual"]')).toContain('Open task')
    browser.screenshot(`${artifactsDir}/automations-log.png`)

    // Enable it: the week view shows its block, the rail lists it.
    expect((await api(`/automations/${automation!.id}/enable`, { method: 'POST' })).status).toBe(200)
    browser.goto(`${baseUrl}/p/${bootProject}/automations?view=week`)
    browser.waitForFunction(`[...document.querySelectorAll('[data-slot="event-block"]')].some((block) => block.textContent.includes(${JSON.stringify(name)}))`)
    browser.screenshot(`${artifactsDir}/automations-week.png`)
    browser.goto(`${baseUrl}/p/${bootProject}/automations?view=day`)
    browser.waitForFunction(`document.querySelector('[data-slot="day-view"]') !== null`)
    browser.screenshot(`${artifactsDir}/automations-day.png`)

    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(rowSelector)}) !== null && document.querySelector(${JSON.stringify(rowSelector)}).textContent.includes('enabled')`)
    clickButton('Next runs')
    browser.waitForFunction(`document.querySelector('[data-slot="next-runs-rail"]') !== null`)
    expect(browser.text('[data-slot="next-runs-rail"]')).toContain(name)
    // The sheet slides in over 500ms; shoot it settled, not mid-animation.
    browser.waitForFunction(`document.querySelector('[data-slot="next-runs-rail"]').getBoundingClientRect().right <= window.innerWidth + 1 && document.querySelector('[data-slot="next-runs-rail"]').getAttribute('data-state') === 'open' && !document.querySelector('[data-slot="next-runs-rail"]').getAnimations().length`)
    browser.screenshot(`${artifactsDir}/automations-next-runs-rail.png`)
    browser.press('Escape')

    // Pause from the row, then the editor shows the edit header with the last run card.
    browser.waitForFunction(`document.querySelector('[data-slot="next-runs-rail"]') === null`)
    clickByAriaLabel('Pause', rowSelector)
    browser.waitForFunction(`document.querySelector(${JSON.stringify(rowSelector)}).textContent.includes('paused')`)
    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automation!.id}`)
    browser.waitForFunction(`document.querySelector('[data-slot="last-run-card"]') !== null`)
    expect(browser.text('main')).toContain('Edit automation')
    browser.screenshot(`${artifactsDir}/automations-editor-edit.png`)
  }, 120_000)

  it('creates a GitHub poll paused, previews it, enables it from a baseline, and logs both', async ({ skip }) => {
    skip(!automationsAvailable, 'opted out')
    const name = `E2E issue triage ${process.pid}`
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') !== null`)
    clickButton('Hide templates')
    browser.waitForFunction(`document.querySelector('[data-slot="template-palette"]') === null`)
    clickButton('When GitHub changes')
    browser.waitForFunction(`document.querySelector('[data-slot="editor-github"]') !== null`)
    browser.screenshot(`${artifactsDir}/automations-editor-new-github.png`)
    browser.fill('[aria-label="Name"]', name)
    browser.fill('[aria-label="Prompt"]', 'Triage {{github.url}}')
    clickButton('Save paused')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/automations'`)

    const automation = (await listAutomations()).find((item) => item.name === name)
    expect(automation).toMatchObject({ enabled: false, kind: 'github' })
    created.push(automation!.id)

    const preview = (await (await api(`/automations/${automation!.id}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    })).json()) as { checkId: string }
    let check: { status: string; error?: string } = { status: 'queued' }
    for (let attempt = 0; attempt < 60 && !['complete', 'error'].includes(check.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      check = (await (await api(`/automation-checks/${preview.checkId}`)).json()) as { status: string; error?: string }
    }
    expect(check.status, check.error).toBe('complete')

    await api(`/automations/${automation!.id}/enable`, { method: 'POST' })
    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automation!.id}/log`)
    browser.waitForFunction(`document.querySelector('[data-slot="log-row"][data-result="baseline"]') !== null && document.querySelector('[data-slot="log-row"][data-result="preview"]') !== null`)
    expect(browser.text('[data-slot="log-row"][data-result="baseline"]')).toContain('current-time baseline')
  }, 60_000)
})
