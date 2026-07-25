import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * The Tools dropdown (Step 4.2) against the shared dev env — a real `/api/health` probing this
 * machine's actual toolchain. Nothing here hardcodes a tool name: the suite fetches the health
 * answer from Node (as smoke.e2e.ts does — `eval` cannot await) and asserts the menu renders
 * exactly that, whatever this machine happens to have installed.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const runId = `e2e-tools-${process.pid}`

type Health = {
  version: string
  checks: Array<{ name: string; available: boolean; version?: string; hint?: string }>
}

let browser: AgentBrowser
let baseUrl: string
let health: Health
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

const TRIGGER = '[data-slot="tools-menu-trigger"]'
const MENU = '[data-slot="tools-menu-content"]'

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  health = (await fetch(`${baseUrl}/api/health`).then((r) => r.json())) as Health
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(runId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

describe('tools menu', () => {
  beforeAll(() => {
    browser.goto(baseUrl + scoped('/'))
    // The trigger is data-driven: it exists only once the health query has answered.
    browser.waitForFunction(`document.querySelector('${TRIGGER}') !== null`)
  })

  it('summarizes the health answer on the closed trigger', () => {
    // The server really probed something — otherwise every assertion below is vacuous.
    expect(health.checks.length).toBeGreaterThan(0)

    const missing = health.checks.filter((c) => !c.available).map((c) => c.name)
    const expectedTitle =
      missing.length === 0
        ? `cezar v${health.version}`
        : `cezar v${health.version} · needs attention: ${missing.join(', ')}`
    expect(browser.evaluate(`document.querySelector('${TRIGGER}').getAttribute('title')`)).toBe(expectedTitle)

    // Aggregate dot: green only when nothing needs attention.
    expect(
      browser.evaluate(`document.querySelector('${TRIGGER} [data-slot="status-dot"]').dataset.tone`)
    ).toBe(missing.length === 0 ? 'success' : 'pending')
  })

  it('opens a menu listing exactly the tools /api/health reports', () => {
    browser.click(TRIGGER)
    browser.waitForFunction(`document.querySelector('${MENU}') !== null`)

    const rows = browser.evaluate(`[...document.querySelectorAll('${MENU} [data-slot="tool-row"]')].map((row) => ({
      name: row.dataset.tool,
      available: row.dataset.available,
      version: row.querySelector('[data-slot="tool-version"]')?.textContent ?? null,
      hint: row.querySelector('[data-slot="tool-hint"]')?.textContent ?? null,
      setupHref: (row.closest('a') ?? row.querySelector('a'))?.getAttribute('href') ?? null,
    }))`) as Array<{
      name: string
      available: string
      version: string | null
      hint: string | null
      setupHref: string | null
    }>

    // The same names, in the same order, and none the server did not send.
    expect(rows.map((r) => r.name)).toEqual(health.checks.map((c) => c.name))

    for (const check of health.checks) {
      const row = rows.find((r) => r.name === check.name)
      expect(row?.available).toBe(String(check.available))
      if (check.available) {
        // The server's version string, verbatim (the shared env runs CEZ_DRY_RUN, so claude's
        // may legitimately be "mock (CEZ_DRY_RUN=1)" — the point is fidelity, not the value).
        expect(row?.version).toBe(check.version ?? 'not found')
        expect(row?.setupHref).toBeNull()
      } else {
        expect(row?.version).toBe('not found')
        if (check.hint) expect(row?.hint).toBe(check.hint)
        expect(row?.setupHref).toBe(scoped('/settings/agents'))
      }
    }

    browser.screenshot(`${artifactsDir}/tools-menu-open.png`)
  })

  it('routes the cog row to Settings → Agents and closes the menu', () => {
    // Still open from the previous test — the cog row is its footer.
    expect(
      browser.evaluate(`document.querySelector('${MENU} [data-slot="tools-settings"]').getAttribute('href')`)
    ).toBe(scoped('/settings/agents'))

    browser.click(`${MENU} [data-slot="tools-settings"]`)
    browser.waitForFunction(`location.pathname === '${scoped('/settings/agents')}'`)
    browser.waitForFunction(`document.querySelector('${MENU}') === null`)
    expect(browser.count(MENU)).toBe(0)
    expect(browser.url()).toContain('/settings/agents')
  })
})
