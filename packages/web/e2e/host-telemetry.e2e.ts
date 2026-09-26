import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * The host-telemetry viewport gate (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, Implementation Plan step 9).
 *
 * Two viewports, two different writers, and the assertions jsdom cannot make:
 *
 *   - **1440×900**: the sidebar glance is mounted, it sits in the desktop sidebar above the
 *     footer's own rows, it links to Settings → Resources, and it draws a sparkline - which is
 *     only possible if the root subscription really held the `host` topic for the session.
 *   - **390×844**: the widget is UNMOUNTED (not merely hidden), the drawer still opens, and the
 *     Machine card on Settings → Resources is still live - the card's own view subscription is
 *     the demand below `md`.
 *
 * A 264 px sidebar check rides along on the desktop pass, because the glance is the first thing
 * added to that column since #702 and the column's width is what makes its compact row necessary.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-host-telemetry-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 }
const DEFAULT_SIDEBAR_WIDTH = 264

const WIDGET = '[data-slot="host-usage-widget"]'
const CARD = '[data-slot="machine-card"]'
const MENU_BUTTON = '[data-slot="mobile-top-bar"] button[aria-label="Open menu"]'

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  const env = readTestEnv()
  baseUrl = env.baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
})

describe('host telemetry across the md breakpoint', () => {
  it('mounts the sidebar glance on a desktop viewport, next to the card that shares its store', () => {
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    browser.goto(baseUrl + scoped('/settings/resources'))
    browser.waitForFunction(`document.querySelector('${CARD}') !== null`)

    // The glance is mounted inside the DESKTOP sidebar, above the footer's own two rows.
    const info = browser.evaluate(`(() => {
      const widget = document.querySelector('${WIDGET}')
      if (!widget) return null
      const sidebar = document.querySelector('[data-slot="sidebar"]')
      const footer = document.querySelector('[data-slot="sidebar-footer"]')
      const link = widget.closest('a')
      return {
        inSidebar: sidebar ? sidebar.contains(widget) : false,
        inFooterRow: footer ? footer.contains(widget) : false,
        href: link ? link.getAttribute('href') : null,
        sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
        cpu: widget.querySelector('[data-slot="host-usage-widget-cpu"]')?.textContent ?? null,
        mem: widget.querySelector('[data-slot="host-usage-widget-mem"]')?.textContent ?? null,
      }
    })()`) as {
      inSidebar: boolean
      inFooterRow: boolean
      href: string | null
      sidebarWidth: number | null
      cpu: string | null
      mem: string | null
    } | null

    expect(info).not.toBeNull()
    if (info === null) throw new Error('the sidebar glance is not on the page')
    expect(info.inSidebar).toBe(true)
    expect(info.inFooterRow).toBe(true)
    // The boot project's scope prefix is normalised away by the router for its own pages, so the
    // link is asserted by target rather than by spelling, and then exercised for real below.
    expect(info.href?.endsWith('/settings/resources')).toBe(true)
    expect(info.sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH)
    // The row never renders a bare unitless value: it is a percentage, `sampling…`, `stale` or `—`.
    expect(info.cpu === null ? '' : info.cpu).toMatch(/^(sampling…|stale|—|\d+%)$/)
    expect(info.mem === null ? '' : info.mem).toMatch(/(GB|MB|kB)/)

    // A sparkline needs two frames, i.e. ~4 s of a held `host` topic: this is the end-to-end
    // proof that the root writer - not the card - is feeding the store on this viewport.
    browser.waitForFunction(
      `document.querySelector('[data-slot="host-usage-widget-sparkline"]') !== null`,
    )
    const cardMode = browser.text('[data-slot="machine-card-mode"]')
    expect(cardMode).toBe('live')

    browser.screenshot(resolve(artifactsDir, `${sessionId}-desktop-glance.png`))

    // The whole row is the way in: clicking it lands on the card it summarizes.
    browser.click(WIDGET)
    browser.waitForFunction(`document.querySelector('${CARD}') !== null`)
    expect(browser.url()).toContain('/settings/resources')
  })

  it('unmounts the glance below md while the card stays live, and still opens the drawer', () => {
    browser.setViewport(IPHONE.width, IPHONE.height)
    browser.goto(baseUrl + scoped('/settings/resources'))
    browser.waitForFunction(`document.querySelector('${CARD}') !== null`)

    // UNMOUNTED, not hidden: the phone pays for neither the subscription nor the row.
    expect(browser.count(WIDGET)).toBe(0)
    expect(browser.isVisible(MENU_BUTTON)).toBe(true)
    expect(browser.text('[data-slot="machine-card-mode"]')).toBe('live')

    // The drawer renders the same sidebar content, and the glance is absent there too.
    browser.click(MENU_BUTTON)
    browser.waitForFunction(`document.querySelector('[data-slot="mobile-nav-drawer"]') !== null`)
    expect(browser.count(WIDGET)).toBe(0)

    browser.screenshot(resolve(artifactsDir, `${sessionId}-phone-card.png`))
  })
})
