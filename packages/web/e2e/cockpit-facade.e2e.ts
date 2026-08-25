import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * Standalone Cezar is a consumer of the public cockpit facade. Keep this deliberately narrow:
 * feature assertions remain with their owning e2e specs; this catches the composition boundary
 * being bypassed in the real browser bundle.
 */

const sessionId = `e2e-cockpit-facade-${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

describe('standalone cockpit facade', () => {
  it('uses the browser-routed facade for existing task creation and sidebar navigation', () => {
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-route="tasks"]') !== null`)

    expect(browser.count('[data-cezar-routing="browser"]')).toBe(1)
    expect(browser.count('iframe')).toBe(0)

    const scoped = (path: string) => `/p/${bootProject}${path}`
    const visit = (path: string, marker: string) => {
      browser.click(`[data-slot="sidebar"] nav a[href="${scoped(path)}"]`)
      browser.waitForFunction(`location.pathname === '${scoped(path)}'`)
      browser.waitForFunction(`document.querySelector('${marker}') !== null`)
      expect(browser.count(marker)).toBe(1)
    }

    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    // Wait for the real catalog and explicitly choose the built-in workflow. This does not pin
    // skill/model ordering, but it avoids submitting during the composer's documented catalog
    // loading window.
    browser.click('[data-slot="source-pill"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-option"][data-source-kind="workflow"][data-source-ref="quick-task"]') !== null`,
    )
    browser.click('[data-slot="source-option"][data-source-kind="workflow"][data-source-ref="quick-task"]')
    browser.fill('[data-slot="composer"] textarea', 'Verify the coarse cockpit facade')
    browser.click('[data-slot="composer"] button[aria-label="Start task"]')
    browser.waitForFunction(`location.pathname.startsWith('${scoped('/tasks/')}')`)
    browser.waitForFunction(`document.querySelector('[data-route="task-thread"]') !== null`)

    visit('/', '[data-route="tasks"]')
    visit('/git', '[data-route="repo-git"]')
    visit('/skills', '[data-route="skills"]')
    visit('/workflows', '[data-route="workflows"]')
    visit('/settings', '[data-route="settings"]')

    const githubLink = `[data-slot="sidebar"] nav a[href="${scoped('/github')}"]`
    if (browser.count(githubLink) === 1) {
      visit('/github', '[data-route="github"]')
    } else {
      browser.goto(`${baseUrl}${scoped('/github')}`)
      browser.waitForFunction(`document.querySelector('[data-route="github"]') !== null`)
      expect(browser.text('[data-route="github"]')).toContain('GitHub is unavailable here')
    }
  })
})
