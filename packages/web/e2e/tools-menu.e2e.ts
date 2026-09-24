import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * The Tools dropdown (Step 4.2) against the shared dev env — a real `/api/v1/health` probing this
 * machine's actual toolchain. Nothing here hardcodes a tool name: the suite fetches the health
 * answer from Node (as smoke.e2e.ts does — `eval` cannot await) and asserts the menu renders
 * exactly that, whatever this machine happens to have installed.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const runId = `e2e-tools-${process.pid}`

type Health = {
  version: string
  defaultRunner: string
  checks: Array<{ name: string; available: boolean; version?: string; hint?: string }>
}

/** The agent CLIs among `checks[]` — `gh` and `git` are rows too, but neither runs a task. Kept in
 *  step with the contract's runner enum (`packages/contract/src/health.ts`). */
const RUNNERS = new Set(['claude', 'codex', 'opencode', 'pi'])

/** What (if anything) keeps the aggregate dot from green, derived from the live health answer the
 *  same way `toolsBlocker()` derives it: the dot is amber only when cez cannot start a task at all,
 *  not merely because an optional tool is absent. */
function blockerFor(health: Health): string | null {
  const runners = health.checks.filter((check) => RUNNERS.has(check.name))
  if (runners.length > 0 && !runners.some((check) => check.available)) {
    return 'no agent CLI found — install one to run tasks'
  }
  const preferred = runners.find((check) => check.name === health.defaultRunner)
  if (preferred && !preferred.available) return `default runner (${health.defaultRunner}) not found`
  return null
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
  health = (await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json())) as Health
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

    const blocker = blockerFor(health)
    const missing = health.checks.filter((c) => !c.available).map((c) => c.name)
    let expectedTitle = `cezar v${health.version}`
    if (blocker) expectedTitle += ` · ${blocker}`
    else if (missing.length > 0) expectedTitle += ` · optional: ${missing.join(', ')} not installed`
    expect(browser.evaluate(`document.querySelector('${TRIGGER}').getAttribute('title')`)).toBe(expectedTitle)

    // Aggregate dot: amber only when something genuinely stops a task from starting — a missing
    // optional tool leaves it green, which is the whole point of the blocker rule.
    expect(
      browser.evaluate(`document.querySelector('${TRIGGER} [data-slot="status-dot"]').dataset.tone`)
    ).toBe(blocker ? 'pending' : 'success')
  })

  it('opens a menu listing exactly the tools /api/v1/health reports', () => {
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
