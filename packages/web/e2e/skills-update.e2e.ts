import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * Automatic Open Mercato skill updates against the real CEZ_DRY_RUN cockpit.
 *
 * Reachability: dry-run deliberately reports a deterministic `current` state with no tracked
 * installation, so this spec covers the inherited preference, its persisted override, the
 * honest no-marker navigation state, and the dry-run apply success/upgrade-notes hand-off. An
 * `available` marker is covered structurally by the app-shell unit suite; manufacturing one in
 * Chrome would require a production-only lock file and network-backed `npx skills check`.
 */

const artifactsDir = resolve(
  import.meta.dirname,
  '../../../.ai/runs/2026-07-22-automatic-open-mercato-skills-updates/checkpoint-3-artifacts',
)
const workspaceConfig = resolve(import.meta.dirname, '../../../.ai/qa/cez-home/config.json')
const sessionId = `e2e-skills-update-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 }

let browser: AgentBrowser
let baseUrl: string
let projectId: string
let previousConfig: string | null = null

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) throw new Error(`cezar e2e: ${init?.method ?? 'GET'} ${path} answered ${response.status}`)
  return (await response.json()) as T
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  projectId = await bootProjectId(baseUrl)
  previousConfig = existsSync(workspaceConfig) ? readFileSync(workspaceConfig, 'utf8') : null
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  if (previousConfig === null) rmSync(workspaceConfig, { force: true })
  else writeFileSync(workspaceConfig, previousConfig, 'utf8')
  browser?.close()
})

describe('automatic Open Mercato skills updates', () => {
  it('shows the inherited global preference and persists an explicit override', async () => {
    browser.goto(`${baseUrl}/settings/global/skills`)
    browser.waitForFunction(`document.querySelector('[data-slot="skills-settings-section"]') !== null`)

    expect(browser.isVisible('[data-slot="skills-auto-update"]')).toBe(true)
    expect(browser.text('[data-slot="skills-settings-section"]')).toContain('On (default)')
    expect(browser.text('[data-slot="skills-installation-status"]')).toContain(
      'No tracked Open Mercato installation found.',
    )
    browser.screenshot(`${artifactsDir}/settings-skills-auto-update.png`)

    browser.click('[data-slot="skills-auto-update"]')
    let config = await api<{ skillsAutoUpdate: boolean | null }>('/api/v1/workspace/config')
    for (let attempt = 0; config.skillsAutoUpdate !== false && attempt < 40; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      config = await api('/api/v1/workspace/config')
    }
    expect(config.skillsAutoUpdate).toBe(false)
    // The section reflects the stored override: the toggle is off and Use default is offered.
    expect(browser.evaluate(`document.querySelector('[data-slot="skills-auto-update"]').getAttribute('aria-checked')`)).toBe('false')
    expect(browser.count('[data-action="skills-use-default"]')).toBe(1)

    browser.click('[data-action="skills-use-default"]')
    for (let attempt = 0; config.skillsAutoUpdate !== null && attempt < 40; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      config = await api('/api/v1/workspace/config')
    }
    expect(config.skillsAutoUpdate).toBeNull()
  })

  it('keeps the navigation marker absent for the dry-run current state', () => {
    browser.goto(`${baseUrl}/p/${projectId}/`)
    // Skills lives in the sidebar FOOTER now (workspace library, user decision).
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar-footer"]') !== null`)
    expect(browser.count('[data-slot="nav-update-marker"]')).toBe(0)
    expect(browser.text('[data-slot="sidebar-footer"]')).toContain('Skills')
    browser.screenshot(`${artifactsDir}/skills-navigation-current.png`)
  })

  it('renders dry-run update success and the upgrade-notes hand-off', async () => {
    const state = await api<{ status: string; needsUpgradeNotes: boolean }>(
      '/api/v1/workspace/skills-update/apply',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    )
    expect(state).toMatchObject({ status: 'current', needsUpgradeNotes: true })

    browser.goto(`${baseUrl}/p/${projectId}/skills?skill=__import`)
    browser.waitForFunction(`document.querySelector('[data-slot="skills-update-card"]') !== null`)
    expect(browser.text('[data-slot="skills-update-card"]')).toContain(
      'Installed Open Mercato skills are up to date.',
    )
    expect(browser.text('[data-slot="skills-upgrade-notes"]')).toContain('/om-apply-upgrade-notes')
    browser.screenshot(`${artifactsDir}/skills-update-success.png`)
  })

  it('keeps Skills reachable in mobile navigation without a false marker', () => {
    browser.setViewport(IPHONE.width, IPHONE.height)
    browser.goto(`${baseUrl}/p/${projectId}/`)
    browser.waitForFunction(`document.querySelector('[data-slot="mobile-top-bar"]') !== null`)
    browser.click('[data-slot="mobile-top-bar"] button[aria-label="Open menu"]')
    browser.waitForFunction(`document.querySelector('[role="dialog"] [data-slot="sidebar-footer"]') !== null`)

    expect(browser.text('[role="dialog"] [data-slot="sidebar-footer"]')).toContain('Skills')
    expect(browser.count('[role="dialog"] [data-slot="nav-update-marker"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/skills-mobile-navigation.png`, { viewport: true })
  })
})
