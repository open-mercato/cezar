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
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`)
  if (!response.ok) throw new Error(`workspace config failed: ${response.status}`)
  return response.json() as Promise<WorkspaceConfig>
}

async function putResources(resources: Partial<WorkspaceConfig['resources']>): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`, {
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
  // A known baseline: residue from an interrupted earlier run must not pre-satisfy the waits.
  await putResources({ maxMonitoringSessions: 2, monitoringWakeIntervalMinutes: 5 })
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
    // Settle the config QUERY, not just the section shell: a change dispatched while the
    // form still renders its defaults gets swallowed by the arriving server values.
    // Settle the HYDRATED form, not just the section shell: the select must show the server's
    // own baseline before a change means anything.
    browser.waitForFunction(
      `document.querySelector('[data-slot="resources-max-monitoring"]')?.value === '2'`,
    )
    choose('[data-slot="resources-max-monitoring"]', '3')
    await waitForResources((resources) => resources.maxMonitoringSessions === 3)

    choose('[data-slot="resources-monitoring-wake-mode"]', 'interval')
    // Same hydration rule for the interval input: the baseline 5 must be on screen first.
    browser.waitForFunction(
      `document.querySelector('[data-slot="resources-monitoring-wake-interval"]')?.value === '5'`,
    )
    // Through React's synthetic input, like `choose`: the provider's fill can land as an
    // append on a controlled input.
    browser.evaluate(`(() => {
      const element = document.querySelector('[data-slot="resources-monitoring-wake-interval"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(element, '7')
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="resources-monitoring-wake-interval"]')?.value === '7'`,
    )
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
