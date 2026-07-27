import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-monitoring-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }

interface WorkspaceConfig {
  resources: {
    maxMonitoringSessions: number
    monitoringWakeIntervalMinutes: number | null
  }
}

let browser: AgentBrowser
let baseUrl: string
let original: WorkspaceConfig['resources']

async function workspaceConfig(): Promise<WorkspaceConfig> {
  const response = await fetch(`${baseUrl}/api/workspace/config`)
  if (!response.ok) throw new Error(`workspace config failed: ${response.status}`)
  return response.json() as Promise<WorkspaceConfig>
}

async function putResources(resources: Partial<WorkspaceConfig['resources']>): Promise<void> {
  const response = await fetch(`${baseUrl}/api/workspace/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resources }),
  })
  if (!response.ok) throw new Error(`workspace config update failed: ${response.status}`)
}

async function waitForResources(check: (resources: WorkspaceConfig['resources']) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check((await workspaceConfig()).resources)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('workspace resources never reached the expected state')
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

function gotoResources(): void {
  browser.goto(`${baseUrl}/settings/global/resources`)
  browser.waitForFunction(`document.querySelector('[data-slot="resources-section"]') !== null`)
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  original = (await workspaceConfig()).resources
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(async () => {
  if (original) await putResources({
    maxMonitoringSessions: original.maxMonitoringSessions,
    monitoringWakeIntervalMinutes: original.monitoringWakeIntervalMinutes,
  })
  browser?.close()
})

describe('global Resources monitoring controls', () => {
  it('persists capacity and interval mode through a cold reload', async () => {
    gotoResources()
    choose('[data-slot="resources-max-monitoring"]', '3')
    await waitForResources((resources) => resources.maxMonitoringSessions === 3)

    choose('[data-slot="resources-monitoring-wake-mode"]', 'interval')
    browser.fill('[data-slot="resources-monitoring-wake-interval"]', '7')
    browser.click('[data-action="resources-save-monitoring-wake"]')
    await waitForResources((resources) => resources.monitoringWakeIntervalMinutes === 7)

    gotoResources()
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-max-monitoring"]').value`))).toBe('3')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-mode"]').value`))).toBe('interval')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-interval"]').value`))).toBe('7')
    expect(browser.text('[data-slot="resources-section"]')).toContain('Capacity:')
    expect(browser.text('[data-slot="resources-section"]')).toContain('3 monitoring')
    browser.screenshot(`${artifactsDir}/settings-monitoring-controls.png`)
  })
})
