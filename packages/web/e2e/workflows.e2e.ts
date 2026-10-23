import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * The workflow node editor (spec 2026-09-30-workflow-node-editor) end-to-end against the shared
 * dry-run environment: a new canvas, the palette (a floating panel), a port's `+` stub adding a
 * node wired to that port, live server validation, Save (a real `version: 2` file lands in
 * `.ai/cezar/workflows/`, read back here), and Import through `/api/v1/workflows/parse`.
 * Saved files are removed in afterAll so a developer's repo stays clean.
 */

const sessionId = `e2e-workflows-${process.pid}`
const DESKTOP = { width: 1440, height: 900 }
const repoRoot = resolve(import.meta.dirname, '../../..')
const FLOW = 'e2e-graph-flow'
const IMPORTED = 'e2e-graph-imported'
const savedPath = (name: string) => resolve(repoRoot, `.ai/cezar/workflows/${name}.yaml`)

let browser: AgentBrowser
let baseUrl: string

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  for (const name of [FLOW, IMPORTED]) rmSync(savedPath(name), { force: true })
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  for (const name of [FLOW, IMPORTED]) rmSync(savedPath(name), { force: true })
  browser?.close()
})

const nodeIds = `[...document.querySelectorAll('.react-flow__node')].map((n) => n.dataset.id).sort().join(',')`

describe('workflow node editor against the live dry-run server', () => {
  it('opens a new canvas with only the top bar and the canvas on screen', () => {
    browser.goto(`${baseUrl}/workflows`)
    browser.waitForFunction(`${nodeIds} === 'end,start,work'`)
    expect(browser.count('aside[aria-label="Node palette"]')).toBe(0)
    expect(browser.count('aside[aria-label="Inspector"]')).toBe(0)
    browser.waitForFunction(`document.body.innerText.includes('valid')`)
  })

  it("adds a node from a port's + stub, wired to that port", () => {
    browser.click('button[aria-label="Add a node after Do the task → failed"]')
    browser.waitForFunction(`document.querySelector('aside[aria-label="Node palette"]') !== null`)
    browser.evaluate(
      `[...document.querySelectorAll('aside[aria-label="Node palette"] button')].find((b) => b.textContent.startsWith('Check')).click()`,
    )
    browser.waitForFunction(`${nodeIds} === 'check,end,start,work'`)
    // The palette closed and the new node's inspector opened.
    browser.waitForFunction(`document.querySelector('aside[aria-label="Inspector"]') !== null`)
    expect(browser.count('aside[aria-label="Node palette"]')).toBe(0)
    expect(browser.count('button[aria-label="Add a node after Do the task → failed"]')).toBe(0)
  })

  it('saves a version: 2 file the server can load back', () => {
    browser.fill('input[aria-label="Workflow name"]', FLOW)
    browser.evaluate(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Save').click()`)
    browser.waitForFunction(`location.pathname.endsWith('/workflows/${FLOW}')`)
    expect(existsSync(savedPath(FLOW))).toBe(true)
    const doc = parse(readFileSync(savedPath(FLOW), 'utf8')) as { version: number; edges: { from: string; to: string }[] }
    expect(doc.version).toBe(2)
    expect(doc.edges).toContainEqual({ from: 'work.failed', to: 'check' })
  })

  it('imports pasted YAML through the server parser', () => {
    browser.goto(`${baseUrl}/workflows`)
    browser.waitForFunction(`document.querySelector('.react-flow__node') !== null`)
    browser.click('button[aria-label="Workflow settings"]')
    browser.waitForFunction(`document.querySelector('aside[aria-label="Workflow settings"]') !== null`)
    const pasted = [
      'version: 2',
      `name: ${IMPORTED}`,
      'nodes:',
      '  - { id: start, type: start }',
      '  - { id: gate, type: gate.human, message: Ship it? }',
      'edges:',
      '  - { from: start, to: gate }',
    ].join('\n')
    browser.fill('aside[aria-label="Workflow settings"] textarea[placeholder="paste a workflow file…"]', pasted)
    browser.evaluate(
      `[...document.querySelectorAll('aside[aria-label="Workflow settings"] button')].find((b) => b.textContent.trim() === 'Import').click()`,
    )
    browser.waitForFunction(`${nodeIds} === 'gate,start'`)
  })
})
