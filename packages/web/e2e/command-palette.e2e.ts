import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * The ⌘K command palette (Step 4.3) against the shared dev env, driven the way a user drives
 * it: the keyboard. Ctrl+K (the same binding as ⌘K — the shared shortcut helper registers
 * both), type to filter, Enter to go.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const runId = `e2e-palette-${process.pid}`

const ROOT = '[cmdk-root]'
const INPUT = '[cmdk-input]'
const HINT = '[data-slot="command-palette-hint"]'

let browser: AgentBrowser
let baseUrl: string

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  browser = AgentBrowser.open(runId)
  browser.setViewport(1440, 900)
})

afterAll(() => {
  browser?.close()
})

describe('command palette', () => {
  it('opens on Ctrl+K, filters to a nav item, and Enter navigates and closes it', () => {
    browser.goto(baseUrl + '/')
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    expect(browser.count(ROOT)).toBe(0)

    browser.press('Control+k')
    browser.waitForFunction(`document.querySelector('${ROOT}') !== null`)
    // The palette input owns focus — Enter and further typing land in it.
    browser.waitForFunction(`document.activeElement?.hasAttribute('cmdk-input') === true`)
    browser.screenshot(`${artifactsDir}/command-palette-open.png`)

    // "view work" rides the Views values' `view ` prefix, so the Workflows destination wins the
    // ranking regardless of which runs and skills this shared machine happens to have.
    browser.fill(INPUT, 'view work')
    browser.waitForFunction(
      `document.querySelector('[cmdk-item][aria-selected="true"]')?.getAttribute('data-nav-to') === '/workflows'`,
    )
    browser.screenshot(`${artifactsDir}/command-palette-filtered.png`)

    browser.press('Enter')
    browser.waitForFunction(`location.pathname === '/workflows'`)
    browser.waitForFunction(`document.querySelector('${ROOT}') === null`)
    expect(browser.url()).toContain('/workflows')
    expect(browser.count(ROOT)).toBe(0)
  })

  it('opens from the sidebar footer hint and closes on Escape', () => {
    browser.waitForFunction(`document.querySelector('${HINT}') !== null`)
    browser.click(HINT)
    browser.waitForFunction(`document.querySelector('${ROOT}') !== null`)
    expect(browser.isVisible(INPUT)).toBe(true)

    browser.press('Escape')
    browser.waitForFunction(`document.querySelector('${ROOT}') === null`)
    expect(browser.count(ROOT)).toBe(0)
  })

  it('does not open while typing in a page input', () => {
    // No shell surface has a free-standing input yet (the composer is R4), so the suppression
    // rule is exercised against an injected one — the guard is target-based, not page-based.
    browser.evaluate(
      `(() => { const field = document.createElement('input'); field.id = 'e2e-probe-input'; document.body.appendChild(field); field.focus(); return true })()`,
    )
    browser.press('Control+k')
    // Deterministic absence: the keydown already dispatched synchronously; the palette either
    // opened or it never will.
    expect(browser.count(ROOT)).toBe(0)
    browser.evaluate(`document.getElementById('e2e-probe-input')?.remove()`)
  })
})
