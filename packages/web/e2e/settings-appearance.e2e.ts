import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Global settings shell + Appearance (R6 Step 1.3; moved to the global area in the
 * multi-project step 3.5) end-to-end against the shared dry-run environment.
 *
 * Reachability: everything here is honestly reachable — the settings routes need no forge, no
 * agent CLI and no seeded runs. The suite mutates exactly two stores and restores/neutralizes
 * both: the WORKSPACE `ui-state.json` (saved in beforeAll, restored in afterAll — the inbox
 * suite's save/restore discipline) and the browser session's localStorage theme mirror
 * (flipped back to dark in the same spec, and the session is unique per run anyway).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

// Appearance persists in the WORKSPACE ui-state since step 3.5. `.ai/scripts/test-env-up.sh`
// pins `CEZ_HOME` under `.ai/qa/cez-home`, so that — not the developer's `~/.cezar`, and not
// the repo's `.ai/cezar` — is the file this suite reads and restores.
const cezHomeDir = resolve(import.meta.dirname, '../../../.ai/qa/cez-home')
const uiStateFile = resolve(cezHomeDir, 'ui-state.json')

let browser: AgentBrowser
let baseUrl: string
let previousUiState: string | null = null

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  previousUiState = existsSync(uiStateFile) ? readFileSync(uiStateFile, 'utf8') : null
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave a developer's cockpit wearing this test's appearance.
  if (previousUiState === null) rmSync(uiStateFile, { force: true })
  else writeFileSync(uiStateFile, previousUiState, 'utf8')
  browser?.close()
})

/** The PUT behind an appearance click is fire-and-forget from the UI's point of view — poll
 *  the API until the write lands rather than assume it beat this assertion. */
async function waitForServerAppearance(check: (appearance: Record<string, unknown>) => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/workspace/ui-state`)
    const state = (await res.json()) as { appearance?: Record<string, unknown> }
    if (state.appearance && check(state.appearance)) return state.appearance
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('ui-state.json never showed the expected appearance')
}

describe('settings → appearance against the live dry-run server', () => {
  it('the shell renders the registry sections — hidden ones absent, active one marked', () => {
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-route="settings-global-appearance"]') !== null`)

    // The GLOBAL nav: the original four sections plus the Open Mercato skills preference,
    // and nothing project-scoped.
    const nav = '[data-slot="settings-nav"][data-scope="global"]'
    expect(browser.count(`${nav} [data-section]`)).toBe(5)
    expect(browser.count(`${nav} [data-section="appearance"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="notifications"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="resources"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="skills"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="projects"]`)).toBe(1)
    // Project sections live in the OTHER area; hidden registry entries are nowhere at all.
    expect(browser.count(`${nav} [data-section="agents"]`)).toBe(0)
    expect(browser.count(`${nav} [data-section="bookmarklets"]`)).toBe(0)
    expect(browser.count(`${nav} [data-section="mcp"]`)).toBe(0)
    expect(browser.count(`${nav} [aria-current="page"][data-section="appearance"]`)).toBe(1)
  })

  it('flipping the theme flips the root class and persists across a reload', () => {
    browser.click('[data-slot="appearance-theme"] [data-value="light"]')
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)

    // A fresh navigation: the pre-paint script must re-apply the choice before the bundle.
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.documentElement.classList.contains('light')`)
    expect(browser.count('[data-slot="appearance-theme"] [data-value="light"][aria-checked="true"]')).toBe(1)

    // Back to dark so every other suite screenshots the default palette.
    browser.click('[data-slot="appearance-theme"] [data-value="dark"]')
    browser.waitForFunction(`!document.documentElement.classList.contains('light')`)
  })

  it('accent lands in ui-state.json and re-applies at boot', async () => {
    browser.click('[data-slot="appearance-accent"] [data-value="violet"]')
    browser.waitForFunction(`document.documentElement.dataset.accent === 'violet'`)

    // The server actually persisted it — not just the query cache.
    const appearance = await waitForServerAppearance((a) => a.accent === 'violet')
    expect(appearance.accent).toBe('violet')

    // Cold load: pre-paint mirror + server truth both say violet.
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.documentElement.dataset.accent === 'violet'`)
    expect(browser.count('[data-slot="appearance-accent"] [data-value="violet"][aria-checked="true"]')).toBe(1)
  })

  it('compact density measurably tightens the spacing scale', async () => {
    // h-14 header: 14 spacing units. Comfortable = 4px/unit → 56px.
    const header = `document.querySelector('[data-route="settings-global-appearance"] header')`
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(56)

    browser.click('[data-slot="appearance-density"] [data-value="compact"]')
    browser.waitForFunction(`document.documentElement.dataset.density === 'compact'`)
    // The same 14 units at 3.5px/unit — the token really drives the built CSS.
    expect(Number(browser.evaluate(`${header}.offsetHeight`))).toBe(49)
    await waitForServerAppearance((a) => a.density === 'compact')

    browser.screenshot(`${artifactsDir}/settings-appearance.png`)

    // Neutralize for the rest of the suite run (afterAll restores the file itself too).
    browser.click('[data-slot="appearance-density"] [data-value="comfortable"]')
    browser.click('[data-slot="appearance-accent"] [data-value="lime"]')
    browser.waitForFunction(
      `document.documentElement.dataset.density === undefined && document.documentElement.dataset.accent === undefined`,
    )
  })
})
