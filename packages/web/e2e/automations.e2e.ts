import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-automations-${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let automationId: string | undefined
/** `capabilities.automations` (#801) — the shared environment boots WITHOUT the opt-in, which is
 *  what a default cezar does, so the enabled-path cases below skip unless it was turned on. */
let automationsAvailable = false

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
  if (automationId) await fetch(`${baseUrl}/api/v1/automations/${automationId}`, { method: 'DELETE' })
})

describe('GitHub automations', () => {
  // The default shape of the product, asserted in a real browser: nothing about automations is
  // reachable or advertised until an operator opts in. Before #801 this sidebar item was present
  // on every project with a GitHub remote, which is exactly what the flag exists to undo.
  it('is absent from the sidebar and refuses its API without the opt-in', async ({ skip }) => {
    skip(automationsAvailable, 'the shared environment explicitly enabled automations')
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    expect(browser.text('[data-slot="sidebar"]')).not.toContain('Automations')

    // The deep link still resolves — the route map is unchanged — but says the feature is off.
    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.body.textContent.includes('GitHub automations are off')`)
    expect(browser.text('main')).toContain('CEZ_AUTOMATIONS=1')
    browser.screenshot(`${artifactsDir}/automations-disabled.png`)

    const refused = await fetch(`${baseUrl}/api/v1/automations`)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('CEZ_AUTOMATIONS')
  }, 60_000)

  it('creates paused, previews safely, enables from a baseline, and exposes the log', async ({ skip }) => {
    skip(
      !automationsAvailable,
      'automations are opt-in; run CEZ_AUTOMATIONS=1 npm run test:e2e -- --force',
    )
    const name = `E2E issue triage ${process.pid}`
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    browser.waitForFunction(`document.querySelector('#automation-name') !== null`)
    browser.fill('#automation-name', name)
    browser.fill('#automation-prompt', 'Triage {{github.url}}')
    browser.click('button[type="submit"]')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/automations'`)

    const created = await fetch(`${baseUrl}/api/v1/automations`).then((response) => response.json()) as {
      automations: Array<{ id: string; name: string; enabled: boolean }>
    }
    const automation = created.automations.find((item) => item.name === name)
    expect(automation).toMatchObject({ enabled: false })
    automationId = automation!.id
    browser.waitForFunction(`document.body.textContent.includes('${name}') && document.body.textContent.includes('Paused')`)

    const preview = await fetch(`${baseUrl}/api/v1/automations/${automationId}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    }).then((response) => response.json()) as { checkId: string }
    let check: { status: string; matches?: number; error?: string } = { status: 'queued' }
    for (let attempt = 0; attempt < 60 && !['complete', 'error'].includes(check.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      check = await fetch(`${baseUrl}/api/v1/automation-checks/${preview.checkId}`).then((response) => response.json())
    }
    expect(check.status, check.error).toBe('complete')

    await fetch(`${baseUrl}/api/v1/automations/${automationId}/enable`, { method: 'POST' })
    browser.goto(`${baseUrl}/p/${bootProject}/automations`)
    browser.waitForFunction(`document.body.textContent.includes('${name}') && document.body.textContent.includes('Enabled')`)
    browser.screenshot(`${artifactsDir}/automations-enabled.png`)

    browser.goto(`${baseUrl}/p/${bootProject}/automations/${automationId}/log`)
    browser.waitForFunction(`document.body.textContent.includes('Execution log') && document.body.textContent.includes('Enabled from a current-time baseline')`)
    expect(browser.text('main')).toContain('Baseline')
    expect(browser.text('main')).toContain('Preview')
    browser.screenshot(`${artifactsDir}/automations-execution-log.png`)
  }, 60_000)
})
