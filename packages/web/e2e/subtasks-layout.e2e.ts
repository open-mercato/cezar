import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/thread-run.record.json'

// Isolated historical trees: no actual agents, approvals or user state are changed.
let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let project: string
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const parents = [50, 100].map((count) => ({ ...record, id: `layout-${count}`, titleSummary: `Task with ${count} subtasks` }))

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-subtasks-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  const runs = parents.flatMap((parent, index) => [parent, ...Array.from({ length: [50, 100][index]! }, (_, i) => ({
    ...record, id: `${parent.id}-child-${i}`, titleSummary: `Historical subtask ${i} with a long readable title`,
    dispatch: { rootRunId: parent.id, parentRunId: parent.id },
  }))])
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify(runs))
  for (const parent of parents) {
    const events = [
      { type: 'session.started', sessionId: 'fixture', backend: 'claude', stepId: 'task' },
      { type: 'turn.started', turnId: 'fixture-turn', stepId: 'task' },
      { type: 'item.completed', item: { kind: 'message', id: 'latest-message', role: 'assistant', text: 'Latest agent message remains readable. Please review the approval below.' }, stepId: 'task' },
      { type: 'ask.requested', requestId: 'fixture-approval', questions: [{ header: 'Approval', question: 'Keep the conversation visible?', multiSelect: false, options: [{ label: 'Approve layout', description: 'Fixture only' }, { label: 'Review first', description: 'Fixture only' }] }] },
    ].map((event, i) => ({ ...event, seq: i + 1, ts: '2026-10-06T09:00:00.000Z' }))
    writeFileSync(join(dataRoot, '.ai/cezar/runs', `${parent.id}.ndjson`), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  }
  const port = await new Promise<number>((done) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => done(typeof address === 'object' && address ? address.port : 0)) }) })
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], { env: fixtureServeEnv(dataRoot), stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${baseUrl}/api/v1/health`)).ok) break } catch { /* starting */ }
    await new Promise((done) => setTimeout(done, 250))
  }
  project = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(`e2e-subtasks-${process.pid}`)
}, 120_000)

afterAll(() => { browser?.close(); server?.kill(); if (dataRoot) rmSync(dataRoot, { recursive: true, force: true }) })

function geometry() {
  return browser.evaluate(`(() => {
    const rect = (selector) => { const e = document.querySelector(selector), r = e.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height, width:r.width } }
    const list = document.querySelector('[data-slot="dispatch-children-list"]')
    return { header:rect('[data-slot="run-header"]'), tabs:rect('[data-slot="run-tabs"]'), message:rect('[data-slot="assistant-message"]'), approval:rect('[data-slot="ask-card"]'), dock:rect('[data-slot="thread-dock"]'), listHeight:list.getBoundingClientRect().height, scrollHeight:list.scrollHeight, overflow:getComputedStyle(list).overflowY, viewport:innerHeight }
  })()`) as { header: { bottom: number }; tabs: { bottom: number }; message: { top: number; bottom: number }; approval: { top: number; bottom: number }; dock: { top: number; bottom: number }; listHeight: number; scrollHeight: number; overflow: string; viewport: number }
}

describe('large subtask header at normal MacBook zoom', () => {
  for (const count of [50, 100]) for (const theme of ['light', 'dark']) {
    it(`${count} children, ${theme}: expanded tree never hides latest message, approval or reply`, () => {
      browser.setViewport(1280, 800)
      browser.goto(`${baseUrl}/p/${project}/tasks/layout-${count}`)
      browser.waitForFunction(`document.querySelectorAll('[data-slot="dispatch-child"]').length === 3 && !!document.querySelector('[data-slot="ask-card"]') && !!document.querySelector('[data-slot="thread-dock"]')`)
      browser.evaluate(`localStorage.setItem('cez-theme', '${theme}')`)
      browser.goto(`${baseUrl}/p/${project}/tasks/layout-${count}`)
      browser.waitForFunction(`document.documentElement.classList.contains('light') === ${theme === 'light'} && document.querySelectorAll('[data-slot="dispatch-child"]').length === 3 && !!document.querySelector('[data-slot="ask-card"]')`)
      const visible = () => {
        const g = geometry()
        expect(g.listHeight).toBeLessThanOrEqual(64)
        expect(g.overflow).toBe('auto')
        expect(g.header.bottom).toBeLessThan(g.message.top)
        expect(g.message.bottom).toBeLessThanOrEqual(g.dock.top)
        expect(g.approval.top).toBeGreaterThanOrEqual(g.header.bottom)
        expect(g.approval.bottom).toBeLessThanOrEqual(g.dock.top)
        expect(g.dock.bottom).toBeLessThanOrEqual(g.viewport)
      }
      visible()
      browser.click('[data-slot="dispatch-children"] button:last-child')
      browser.waitForFunction(`document.querySelectorAll('[data-slot="dispatch-child"]').length === ${count}`)
      visible()
      expect(geometry().scrollHeight).toBeGreaterThan(geometry().listHeight)
      browser.evaluate(`document.querySelector('[data-slot="dispatch-children-list"]').scrollTop = 100000`)
      visible()
      browser.screenshot(join(artifacts, `subtasks-${count}-${theme}.png`), { viewport: true })
      browser.click('[data-slot="dispatch-children"] button[aria-expanded]')
      expect(browser.count('[data-slot="dispatch-child"]')).toBe(0)
      expect(browser.isVisible('[data-slot="ask-card"]')).toBe(true)
      expect(browser.isVisible('[data-slot="thread-dock"]')).toBe(true)
      for (const tab of ['Session', 'Changes', 'Commits', 'Files']) expect(browser.text('[data-slot="run-tabs"]')).toContain(tab)
      expect(browser.text('[data-slot="run-actions"]')).toContain('Notes')
      expect(browser.text('[data-slot="run-actions"]')).toContain('Pin')
    }, 120_000)
  }
})
