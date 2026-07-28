import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-automations-${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let automationId: string | undefined

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(async () => {
  browser?.close()
  if (automationId) await fetch(`${baseUrl}/api/automations/${automationId}`, { method: 'DELETE' })
})

describe('GitHub automations', () => {
  it('creates paused, previews safely, enables from a baseline, and exposes the log', async () => {
    const name = `E2E issue triage ${process.pid}`
    browser.goto(`${baseUrl}/p/${bootProject}/automations/new`)
    browser.waitForFunction(`document.querySelector('#automation-name') !== null`)
    browser.fill('#automation-name', name)
    browser.fill('#automation-prompt', 'Triage {{github.url}}')
    browser.click('button[type="submit"]')
    browser.waitForFunction(`location.pathname === '/p/${bootProject}/automations'`)

    const created = await fetch(`${baseUrl}/api/automations`).then((response) => response.json()) as {
      automations: Array<{ id: string; name: string; enabled: boolean }>
    }
    const automation = created.automations.find((item) => item.name === name)
    expect(automation).toMatchObject({ enabled: false })
    automationId = automation!.id
    browser.waitForFunction(`document.body.textContent.includes('${name}') && document.body.textContent.includes('Paused')`)

    const preview = await fetch(`${baseUrl}/api/automations/${automationId}/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'preview' }),
    }).then((response) => response.json()) as { checkId: string }
    let check: { status: string; matches?: number; error?: string } = { status: 'queued' }
    for (let attempt = 0; attempt < 60 && !['complete', 'error'].includes(check.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      check = await fetch(`${baseUrl}/api/automation-checks/${preview.checkId}`).then((response) => response.json())
    }
    expect(check.status, check.error).toBe('complete')

    await fetch(`${baseUrl}/api/automations/${automationId}/enable`, { method: 'POST' })
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
