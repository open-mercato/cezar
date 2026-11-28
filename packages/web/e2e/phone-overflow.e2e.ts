import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser } from './agent-browser'
import { bootOverflowFixture, type OverflowFixture } from './fixtures/phone-overflow-seed'

/**
 * Nothing scrolls sideways at phone widths (the Approvals bug: a merge card's unbroken task id
 * blew the page to ~860px inside the app's scroll region, where `document.scrollWidth` alone
 * never sees it). Over a fixture seeded with unbroken ids, SHAs and URLs, each page must:
 *
 *   1. keep the document and every scroll region within the viewport, except the scrollers that
 *      are horizontal on purpose (code fences, the task view's tab strip, the settings chip nav,
 *      the cross-project Tasks table, whose title column has a designed minimum width);
 *   2. draw no element past the right edge outside those scrollers.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-phone-overflow-${process.pid}`
const WIDTHS = [360, 390] as const

/** Horizontal by design: each scrolls in place, inside the viewport. */
const INTENDED_SCROLLERS = [
  '[data-streamdown="code-block-body"]',
  'pre',
  '[data-slot="layout-cards"]',
  '[data-slot="settings-nav-mobile"]',
  '[data-slot="global-tasks-table"]',
]

const PROBE = `(() => {
  const allowed = ${JSON.stringify(INTENDED_SCROLLERS.join(','))}
  const width = document.documentElement.clientWidth
  const label = (el) => el.tagName.toLowerCase() + (el.dataset.slot ? '[data-slot=' + el.dataset.slot + ']' : '') + ' "' + (el.textContent || '').trim().slice(0, 40) + '"'
  const problems = []
  if (document.documentElement.scrollWidth > width) problems.push('document ' + document.documentElement.scrollWidth + ' > ' + width)
  // Only a deliberate clip hides overflow: an ellipsis, a line clamp, or sr-only text. A card's
  // overflow:hidden cutting a sentence off is exactly the bug.
  const deliberatelyClipped = (from) => {
    for (let up = from; up; up = up.parentElement) {
      const css = getComputedStyle(up)
      if (!/(hidden|clip)/.test(css.overflowX) || up.getBoundingClientRect().right > width + 1) continue
      return css.textOverflow === 'ellipsis' || css.webkitLineClamp !== 'none' || up.getBoundingClientRect().width <= 1
    }
    return false
  }
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest(allowed)) continue
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) continue
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1) problems.push('scrolls sideways: ' + label(el) + ' ' + el.scrollWidth + ' > ' + el.clientWidth)
    if (rect.right > width + 1 && rect.left < width && !deliberatelyClipped(el)
      && ![...el.children].some((child) => child.getBoundingClientRect().right > width + 1)) problems.push('past the edge: ' + label(el) + ' right=' + Math.round(rect.right))
  }
  // Text runs past its own box without widening it: measure the glyphs, not the elements.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const host = node.parentElement
    if (!host || !node.textContent.trim() || host.closest(allowed)) continue
    range.selectNodeContents(node)
    const box = range.getBoundingClientRect()
    if (box.width && box.right > width + 1 && box.left < width && !deliberatelyClipped(host)) problems.push('text past the edge: ' + label(host) + ' right=' + Math.round(box.right))
  }
  return JSON.stringify(problems.slice(0, 10))
})()`

let browser: AgentBrowser
let fixture: OverflowFixture

beforeAll(async () => {
  fixture = await bootOverflowFixture()
  browser = AgentBrowser.open(sessionId)
}, 300_000)

afterAll(async () => {
  browser?.close()
  await fixture?.stop()
})

const waitFor = (selector: string) => browser.waitForFunction(`document.querySelector(${JSON.stringify(selector)}) !== null`)

/** A settings menu row by its text: the rows share one slot. */
const clickMenuItem = (text: string) =>
  browser.evaluate(`(() => { const row = [...document.querySelectorAll('[data-slot="manager-settings-menu"] button')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)})); if (!row) throw new Error('no menu row ' + ${JSON.stringify(text)}); row.click(); return true })()`)

/** Opens a chat's settings menu, then, given a row, one of its dialogs. */
const openSettingsDialog = (row?: string) => () => {
  waitFor('button[aria-label="Manager settings"]')
  browser.click('button[aria-label="Manager settings"]')
  waitFor('[data-slot="manager-settings-menu"]')
  if (row) clickMenuItem(row)
}

/** `open` reaches a popover or dialog first; `ready` is then real content inside it. */
function sweep(slug: string, path: string, ready: string, width: number, open?: { trigger: string } | (() => void)): void {
  browser.setViewport(width, 844)
  browser.goto(fixture.baseUrl + path)
  if (typeof open === 'function') open()
  else if (open) {
    waitFor(open.trigger)
    browser.click(open.trigger)
  }
  waitFor(ready)
  // Fonts and the reference chips settle the last widths.
  browser.waitForFunction('document.fonts.status === "loaded"')
  const problems = JSON.parse(String(browser.evaluate(PROBE))) as string[]
  browser.screenshot(`${artifactsDir}/phone-overflow-${slug}-${width}.png`, { viewport: true })
  expect(problems, `${path} at ${width}px`).toEqual([])
}

describe.each(WIDTHS)('phone overflow at %ipx', (width) => {
  it('Manager approvals', () => {
    sweep('approvals', '/manager/approvals', '[data-slot="manager-action"] [data-slot="decision-sources"]', width)
  })
  it('Manager questions', () => {
    sweep('questions', '/manager/questions', '[data-route="questions"] h1', width)
  })
  it('Manager chat: messages, question, merge and job cards', () => {
    sweep('chat', `/manager/${fixture.managerId}`, '[data-slot="manager-action"][data-status="pending"]', width)
  })
  it('Plan usage popover', () => {
    sweep('plan-usage', `/manager/${fixture.managerId}`, '[data-slot="manager-usage-account"], [data-slot="manager-usage-none"]', width, { trigger: '[data-slot="manager-usage-chip"]' })
  })
  it('Manager settings menu', () => {
    sweep('settings-menu', `/manager/${fixture.managerId}`, '[data-slot="manager-settings-menu"] button', width, openSettingsDialog())
  })
  it('Memory dialog', () => {
    sweep('memory', `/manager/${fixture.managerId}`, '[data-slot="manager-memory-entry"]', width, openSettingsDialog('Memory'))
  })
  it('Connectors dialog', () => {
    sweep('connectors', `/manager/${fixture.managerId}`, '[data-slot="manager-connector"], [data-slot="manager-connectors-unavailable"]', width, openSettingsDialog('Connectors'))
  })
  it('Manager directory', () => {
    sweep('managers', '/manager?all=1', '[data-route="manager-list"] [data-slot]', width)
  })
  it('Now', () => {
    sweep('now', `/p/${fixture.projectId}/`, '[data-slot="now-attention-row"]', width)
  })
  it('Tasks', () => {
    sweep('tasks', `/p/${fixture.projectId}/tasks`, '[data-slot="task-cards"], [data-slot="tasks-table"]', width)
  })
  it('Task thread', () => {
    sweep('thread', `/p/${fixture.projectId}/tasks/${fixture.runIds[0]}`, '[data-slot="thread-dock"]', width)
  })
  it('Automations', () => {
    sweep('automations', `/p/${fixture.projectId}/automations`, '[data-slot="automations-toolbar"]', width)
  })
  it('Settings', () => {
    sweep('settings', '/settings/global/appearance', '[data-route="settings-global-appearance"]', width)
  })
})
