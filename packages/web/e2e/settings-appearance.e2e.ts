import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * Global settings shell + Appearance (R6 Step 1.3; moved to the global area in the
 * multi-project step 3.5) end-to-end against the shared dry-run environment.
 *
 * Reachability: everything here is honestly reachable — the settings routes need no forge, no
 * agent CLI and no seeded runs. The suite restores the workspace UI state and branding files
 * with their original contents and modes; the browser session's localStorage theme mirror is
 * flipped back to dark, and its session is unique per run anyway.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

// Appearance persists in the WORKSPACE ui-state since step 3.5. `.ai/scripts/test-env-up.sh`
// pins `CEZ_HOME` under `.ai/qa/cez-home`, so that — not the developer's `~/.cezar`, and not
// the repo's `.ai/cezar` — is the file this suite reads and restores.
const cezHomeDir = resolve(import.meta.dirname, '../../../.ai/qa/cez-home')
const uiStateFile = resolve(cezHomeDir, 'ui-state.json')
const brandingFiles = ['config.json', 'config.json.bak', 'branding-logo', '.png', '.jpg', '.webp', '.gif', '.avif', '.svg']
  .map((name) => resolve(cezHomeDir, name.startsWith('config.json') || name === 'branding-logo' ? name : `branding-logo${name}`))
const stateFiles = [uiStateFile, ...brandingFiles]

let browser: AgentBrowser
let baseUrl: string
let previousStateFiles = new Map<string, { contents: Buffer; mode: number } | null>()

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  previousStateFiles = new Map(stateFiles.map((path) => [
    path,
    existsSync(path) ? { contents: readFileSync(path), mode: statSync(path).mode & 0o7777 } : null,
  ]))
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave the shared test home with this test's UI state or branding.
  for (const [path, previous] of previousStateFiles) {
    if (previous === null) rmSync(path, { force: true })
    else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, previous.contents, { mode: previous.mode })
      chmodSync(path, previous.mode)
    }
  }
  browser?.close()
})

/** The PUT behind an appearance click is fire-and-forget from the UI's point of view — poll
 *  the API until the write lands rather than assume it beat this assertion. */
async function waitForServerAppearance(check: (appearance: Record<string, unknown>) => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/v1/workspace/ui-state`)
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

    // The GLOBAL nav: appearance, notifications, resources, skills, agent accounts and projects,
    // with nothing project-scoped.
    const nav = '[data-slot="settings-nav"][data-scope="global"]'
    expect(browser.count(`${nav} [data-section]`)).toBe(6)
    expect(browser.count(`${nav} [data-section="appearance"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="notifications"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="resources"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="skills"]`)).toBe(1)
    expect(browser.count(`${nav} [data-section="accounts"]`)).toBe(1)
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

  it('saves workspace branding and renders it in the sidebar and browser tab after reload', async () => {
    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-slot="branding-name"]') !== null`)
    browser.fill('[data-slot="branding-name"]', 'Acme Studio')
    browser.press('Tab')
    let savedName = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await (await fetch(`${baseUrl}/api/v1/workspace/config`)).json() as { branding?: { name?: string } }
      if (current.branding?.name === 'Acme Studio') { savedName = true; break }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(savedName).toBe(true)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>'
    const form = new FormData()
    form.set('file', new File([svg], 'acme.svg', { type: 'image/svg+xml' }))
    const uploaded = await fetch(`${baseUrl}/api/v1/workspace/branding-logo`, { method: 'POST', body: form })
    expect(uploaded.status).toBe(200)

    browser.goto(`${baseUrl}/settings/global/appearance`)
    browser.waitForFunction(`document.querySelector('[data-slot="brand-name"]')?.textContent === 'Acme Studio' && document.querySelector('[data-slot="brand-logo"]') !== null`)
    expect(browser.text('[data-slot="brand-lockup"]')).toContain('Acme Studio')
    expect(String(browser.evaluate(`document.title`))).toContain('Acme Studio')
    expect(String(browser.evaluate(`document.querySelector('link[rel="icon"]').href`))).toContain('/api/v1/workspace/branding-logo?v=')
    expect(Number(browser.evaluate(`document.querySelector('[data-slot="brand-logo"]').naturalWidth`))).toBeGreaterThan(0)
  })
})
