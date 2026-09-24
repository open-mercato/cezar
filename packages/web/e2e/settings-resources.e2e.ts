import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Project settings → Worktrees: retention (#483) end-to-end against the shared dry-run
 * environment. The field moved out of Resources into its own project section in step 3.5
 * (retention sizes one repo's worktree pool; the host-wide knobs went global). Drives the "Keep last N worktrees" field through the real form and reads the
 * write back from `GET /api/v1/config` (the server's truth, not the query cache), proves a cold
 * load renders the persisted value, and checks the worktrees management panel renders (rows or
 * the empty state) with the keep-limit footer.
 *
 * Reachability: fully reachable — the section needs no forge and no agent CLI. It mutates one
 * store, `.ai/cezar/config.json`, saved in beforeAll and restored byte-for-byte in afterAll.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-resources-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }
const dataDir = resolve(import.meta.dirname, '../../../.ai/cezar')
const configFile = resolve(dataDir, 'config.json')

let browser: AgentBrowser
let baseUrl: string
let previousConfig: string | null = null

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  previousConfig = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  if (previousConfig === null) rmSync(configFile, { force: true })
  else writeFileSync(configFile, previousConfig, 'utf8')
  browser?.close()
})

interface ConfigAnswer {
  worktreeRetention: number
}

async function waitForConfig(check: (config: ConfigAnswer) => boolean): Promise<ConfigAnswer> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/v1/config`)
    const config = (await res.json()) as ConfigAnswer
    if (check(config)) return config
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('GET /api/v1/config never showed the expected worktreeRetention')
}

const gotoResources = () => {
  browser.goto(`${baseUrl}/settings/worktrees`)
  browser.waitForFunction(`document.querySelector('[data-slot="worktrees-section"]') !== null`)
}

describe('project settings → worktrees: retention against the live dry-run server', () => {
  it('renders the keep-last-N field and the worktrees panel', () => {
    gotoResources()
    expect(browser.count('[data-slot="resources-worktree-retention"]')).toBe(1)
    // The panel renders either a table or its empty state, plus the keep-limit footer.
    browser.waitForFunction(
      `document.querySelector('[data-slot="worktrees-panel"]') !== null || document.querySelector('[data-slot="worktrees-empty"]') !== null`,
    )
    expect(browser.count('[data-slot="worktrees-footer"]')).toBe(1)
  })

  it('editing the count and saving persists through PUT /api/v1/config', async () => {
    gotoResources()
    browser.fill('[data-slot="resources-worktree-retention"]', '4')
    browser.click('[data-action="resources-save-retention"]')
    await waitForConfig((c) => c.worktreeRetention === 4)
  })

  it('0 saves as unlimited (a real value, not a clear)', async () => {
    browser.fill('[data-slot="resources-worktree-retention"]', '0')
    browser.click('[data-action="resources-save-retention"]')
    const config = await waitForConfig((c) => c.worktreeRetention === 0)
    expect(config.worktreeRetention).toBe(0)
  })

  it('a cold load renders the persisted count — the field is a view of config.json', async () => {
    // Set a distinctive value, then reload from scratch.
    browser.fill('[data-slot="resources-worktree-retention"]', '7')
    browser.click('[data-action="resources-save-retention"]')
    await waitForConfig((c) => c.worktreeRetention === 7)

    gotoResources()
    expect(
      String(browser.evaluate(`document.querySelector('[data-slot="resources-worktree-retention"]').value`)),
    ).toBe('7')
    browser.screenshot(`${artifactsDir}/settings-resources.png`)

    // Neutralize for later suites (afterAll restores the file too).
    browser.fill('[data-slot="resources-worktree-retention"]', '10')
    browser.click('[data-action="resources-save-retention"]')
    await waitForConfig((c) => c.worktreeRetention === 10)
  })
})
