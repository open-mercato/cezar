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
  it('mounts one browser-routed public facade and no iframe', () => {
    browser.goto(`${baseUrl}/p/${bootProject}/`)
    browser.waitForFunction(`document.querySelector('[data-route="tasks"]') !== null`)

    expect(browser.count('[data-cezar-routing="browser"]')).toBe(1)
    expect(browser.count('iframe')).toBe(0)
  })
})
