import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Settings → Agents (R6 Step 1.5) end-to-end against the shared dry-run environment: edit each
 * knob through the real form and read the write back from `GET /api/v1/config` — the server's
 * truth, not the query cache — then prove a cold load renders the persisted values.
 *
 * Reachability: fully reachable — the section needs no forge and no agent CLI; the base-branch
 * picker only needs the dry-run repo to be a git checkout (asserted, not assumed). The suite
 * mutates exactly one store, `.ai/cezar/config.json`, saved in beforeAll and restored byte-for-
 * byte in afterAll (`loadConfig` reads on demand and never caches, so the restore is complete).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-agents-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

// Where `src/index.ts` puts the data dir, for the server booted from this worktree.
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
  // Never leave a developer's cockpit running with this test's agent settings.
  if (previousConfig === null) rmSync(configFile, { force: true })
  else writeFileSync(configFile, previousConfig, 'utf8')
  browser?.close()
})

interface ConfigAnswer {
  baseBranch: string | null
  defaultRunner: string
  systemPrompt: string | null
  defaultModels: Record<string, string>
}

/** The PUT behind a control is fire-and-forget from the UI's point of view — poll the additive
 *  GET /api/v1/config until the write lands rather than assume it beat this assertion. */
async function waitForConfig(check: (config: ConfigAnswer) => boolean): Promise<ConfigAnswer> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/v1/config`)
    const config = (await res.json()) as ConfigAnswer
    if (check(config)) return config
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('GET /api/v1/config never showed the expected knobs')
}

/** Set a native <select> the way a user would, through React's synthetic change — the native
 *  value setter defeats React's value tracker so the dispatched event is not deduped away. */
function setSelect(selector: string, value: string) {
  browser.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

const gotoAgents = () => {
  browser.goto(`${baseUrl}/settings/agents`)
  browser.waitForFunction(`document.querySelector('[data-slot="agents-section"]') !== null`)
}

describe('settings → agents against the live dry-run server', () => {
  it('renders every knob, agent-agnostically named', () => {
    gotoAgents()
    browser.waitForFunction(`document.querySelector('[data-slot="agents-base-branch"]') !== null`)
    expect(browser.count('[data-slot="agents-runner"] [role="radio"]')).toBe(3)
    expect(browser.count('[data-slot="agents-model"]')).toBe(3)
    expect(browser.count('[data-slot="agents-system-prompt"]')).toBe(1)
    // The dry-run repo is a git checkout, so the base-branch picker is the real control.
    expect(browser.count('[data-slot="agents-base-branch"]')).toBe(1)
  })

  it('default runner: click writes config.json and GET /api/v1/config reads it back', async () => {
    gotoAgents()
    browser.click('[data-slot="agents-runner"] [data-value="codex"]')
    await waitForConfig((c) => c.defaultRunner === 'codex')
    expect(browser.count('[data-slot="agents-runner"] [data-value="codex"][aria-checked="true"]')).toBe(1)
  })

  it('per-runner model preset: select writes the runner key, others untouched', async () => {
    setSelect('[data-slot="agents-model"][data-runner="claude"]', 'opus')
    const config = await waitForConfig((c) => c.defaultModels.claude === 'opus')
    expect(config.defaultModels.codex).toBeUndefined()
    expect(config.defaultModels.opencode).toBeUndefined()
  })

  it('system prompt: explicit save persists the trimmed text', async () => {
    browser.fill('[data-slot="agents-system-prompt"]', 'Always add tests. (e2e)')
    browser.click('[data-action="agents-save-prompt"]')
    await waitForConfig((c) => c.systemPrompt === 'Always add tests. (e2e)')
  })

  it('base branch: picking a real branch persists; clearing goes back to the checkout', async () => {
    // Whatever branch the dry-run repo actually has, first option after "follow checked-out branch".
    const branch = String(
      browser.evaluate(`document.querySelector('[data-slot="agents-base-branch"]').options[1]?.value ?? ''`),
    )
    expect(branch).not.toBe('')
    setSelect('[data-slot="agents-base-branch"]', branch)
    await waitForConfig((c) => c.baseBranch === branch)

    setSelect('[data-slot="agents-base-branch"]', '')
    await waitForConfig((c) => c.baseBranch === null)
  })

  it('a cold load renders the persisted knobs — the form is a view of config.json', async () => {
    gotoAgents()
    expect(browser.count('[data-slot="agents-runner"] [data-value="codex"][aria-checked="true"]')).toBe(1)
    expect(
      String(browser.evaluate(`document.querySelector('[data-slot="agents-model"][data-runner="claude"]').value`)),
    ).toBe('opus')
    expect(
      String(browser.evaluate(`document.querySelector('[data-slot="agents-system-prompt"]').value`)),
    ).toBe('Always add tests. (e2e)')
    browser.screenshot(`${artifactsDir}/settings-agents.png`)

    // Neutralize for the suites that follow (afterAll restores the file itself too).
    browser.click('[data-slot="agents-runner"] [data-value="claude"]')
    await waitForConfig((c) => c.defaultRunner === 'claude')
  })
})
