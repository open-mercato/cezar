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

/** Pick an option in a shadcn Select: open the trigger, then click the option by its text. A
 *  programmatic `.click()` is the item's non-mouse path, which selects on click. */
function choose(trigger: string, optionText: string): void {
  browser.click(trigger)
  browser.waitForFunction(`[...document.querySelectorAll('[role="option"]')].some((el) => el.textContent?.trim() === ${JSON.stringify(optionText)})`)
  browser.evaluate(`[...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.trim() === ${JSON.stringify(optionText)}).click()`)
  browser.waitForFunction(`document.querySelector('[role="listbox"]') === null`)
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
    browser.fill('[data-slot="resources-max-monitoring"]', '3')
    browser.press('Enter')
    await waitForResources((resources) => resources.maxMonitoringSessions === 3)
    // The server can answer that poll before the cockpit has its own reply, and the wake controls
    // stay disabled while the shared save is pending — a fill in that gap is silently dropped.
    browser.waitForFunction(`document.querySelector('[data-slot="resources-monitoring-wake-mode"]')?.disabled === false`)

    // The mode saves on change (with the default cadence); the cadence saves on Enter.
    choose('[data-slot="resources-monitoring-wake-mode"]', 'Re-check on an interval')
    await waitForResources((resources) => resources.monitoringWakeIntervalMinutes === 5)
    browser.waitForFunction(`document.querySelector('[data-slot="resources-monitoring-wake-interval"]')?.disabled === false`)
    browser.fill('[data-slot="resources-monitoring-wake-interval"]', '7')
    browser.press('Enter')
    await waitForResources((resources) => resources.monitoringWakeIntervalMinutes === 7)

    gotoResources()
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-max-monitoring"]').value`))).toBe('3')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-mode"]').getAttribute('data-value')`))).toBe('interval')
    expect(String(browser.evaluate(`document.querySelector('[data-slot="resources-monitoring-wake-interval"]').value`))).toBe('7')
    expect(browser.text('[data-slot="resources-section"]')).toContain('Capacity:')
    expect(browser.text('[data-slot="resources-section"]')).toContain('3 monitoring')
    browser.screenshot(`${artifactsDir}/settings-monitoring-controls.png`)
  })
})
