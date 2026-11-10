import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, stopFixtureServer } from './agent-browser'

/**
 * The step that closed a run without failing it (#2022, #2024, #2025), in a real browser: the
 * header, the step rail (collapsed dots and expanded rows) and the Graph tab must agree. Colours
 * are read as COMPUTED styles and compared within the page, so the test holds in either theme
 * and proves the tokens resolve, not just that a class name was written.
 *
 * Boot-own-server doctrine (quick-list.e2e.ts): `runs.json` must exist before boot, and every
 * fixture run is terminal (`failed`), so `recover()` leaves them alone.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-closed-steps-${process.pid}`

const T0 = '2026-11-09T10:00:00.000Z'
const T1 = '2026-11-09T10:02:00.000Z'
const T2 = '2026-11-09T10:05:00.000Z'

const DEF = {
  name: 'verify',
  source: 'file',
  steps: [
    { id: 'implement', name: 'Implement', prompt: '{{task}}' },
    { id: 'tests', name: 'Tests', command: 'npm test', onFail: { retry: 'implement', max: 2 } },
    { id: 'fix', name: 'Fix failures', prompt: 'fix' },
  ],
}

const step = (id: string, name: string, kind: 'agent' | 'check', status: string, finishedAt: string) => ({
  id, name, kind, status, iterations: 1, tokensUsed: 0, startedAt: T0, finishedAt,
})

/** Done → an earlier failed check → the failed step that closed the run (finished last). */
const run = (id: string, title: string, extra: Record<string, unknown>) => ({
  id,
  title,
  workflow: 'verify',
  task: title,
  status: 'failed',
  createdAt: T0,
  startedAt: T0,
  finishedAt: T2,
  tokensUsed: 0,
  archived: false,
  workflowDef: DEF,
  steps: [
    step('implement', 'Implement', 'agent', 'done', T0),
    step('tests', 'Tests', 'check', 'failed', T1),
    step('fix', 'Fix failures', 'agent', 'failed', T2),
  ],
  ...extra,
})

const ANSWER = run('c105ed00-0000-4000-8000-000000002025', 'Closed on an unanswered question', {
  awaitingAnswerSince: T2,
  // The idle timer can be what closed it: the open question still wins (`runClosure`).
  idleClosedAt: T2,
  error: 'the session closed before the question was answered — continue to answer it',
})
const IDLE = run('c105ed00-0000-4000-8000-000000002022', 'Closed after inactivity', {
  idleClosedAt: T2,
  error: 'closed after inactivity',
})
const FAILED = run('c105ed00-0000-4000-8000-000000000001', 'A plain failure', { error: 'the agent failed' })

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the fixture server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

const scoped = (path: string) => `/p/${bootProject}${path}`

type Paint = { visual: string; cls: string; bg: string; color: string; stroke: string; anim: string }

/** One `eval` per read: each agent-browser call is a process spawn. */
function readJson<T>(js: string): T {
  return JSON.parse(String(browser.evaluate(`JSON.stringify(${js})`))) as T
}

const paint = (el: string) =>
  `(() => { const cs = getComputedStyle(${el}); return { visual: ${el}.closest('[data-visual]')?.dataset.visual ?? '', ` +
  `cls: ${el}.getAttribute('class') ?? '', bg: cs.backgroundColor, color: cs.color, stroke: cs.stroke, anim: cs.animationName } })()`

const dots = () =>
  readJson<Paint[]>(`[...document.querySelectorAll('[data-slot="workflow-steps"] [data-slot="step-dot"]')].map((d) => ${paint('d')})`)

const rows = () =>
  readJson<Paint[]>(
    `[...document.querySelectorAll('[data-slot="workflow-steps"] [data-slot="step-row"]')].map((r) => { const svg = r.querySelector('svg'); return ${paint('svg')} })`,
  )

const headerPill = () => browser.text('[data-slot="run-header"] [data-slot="pill"]').trim()

/** Open a run's thread with its rail expanded. */
function openThread(id: string): void {
  browser.goto(`${baseUrl}${scoped(`/tasks/${id}`)}`)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="workflow-steps"] [data-slot="step-dot"]').length === 3`)
}

function expandRail(): void {
  browser.click('[data-slot="workflow-steps"] button[aria-label^="Workflow:"]')
  browser.waitForFunction(`document.querySelectorAll('[data-slot="workflow-steps"] [data-slot="step-row"]').length === 3`)
}

type NodePaint = { status: string; label: string; dotBg: string; dotAnim: string }

function openGraph(id: string): void {
  browser.goto(`${baseUrl}${scoped(`/tasks/${id}/graph`)}`)
  browser.waitForFunction(`document.querySelector('.react-flow__node[data-id="fix"] [data-node-status]') !== null`)
}

const graphNodes = () =>
  readJson<Record<string, NodePaint>>(
    `Object.fromEntries(['implement', 'tests', 'fix'].map((id) => { ` +
      `const n = document.querySelector('.react-flow__node[data-id="' + id + '"] [data-node-status]'); ` +
      `const dot = n?.querySelector('[aria-label]'); const cs = dot ? getComputedStyle(dot) : null; ` +
      `return [id, { status: n?.getAttribute('data-node-status') ?? '', label: dot?.getAttribute('aria-label') ?? '', ` +
      `dotBg: cs?.backgroundColor ?? '', dotAnim: cs?.animationName ?? '' }] }))`,
  )

function nodeDetails(id: string): string {
  browser.click(`.react-flow__node[data-id="${id}"]`)
  browser.waitForFunction(`document.querySelector('[aria-label="Node details"]') !== null`)
  return browser.text('[aria-label="Node details"]')
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-closed-steps-'))
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([ANSWER, IDLE, FAILED], null, 2), 'utf8')
  for (const r of [ANSWER, IDLE, FAILED]) writeFileSync(join(dataRoot, '.ai/cezar/runs', `${r.id}.ndjson`), '')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server, dataRoot)
})

describe('the step rail on a run that closed without failing', () => {
  it('a run closed on an unanswered question: a still amber dot and question mark, never the danger X (#2025)', () => {
    openThread(ANSWER.id)
    expect(headerPill()).toContain('needs you')

    const [done, failed, answer] = dots()
    expect([done!.visual, failed!.visual, answer!.visual]).toEqual(['done', 'failed', 'answer'])
    expect(answer!.bg).not.toBe(failed!.bg)
    expect(answer!.anim).toBe('none') // still: a pulsing amber dot means "the live step"

    expandRail()
    const [, failedRow, answerRow] = rows()
    expect(failedRow!.cls).toContain('lucide-circle-x')
    expect(answerRow!.visual).toBe('answer')
    expect(answerRow!.cls).toContain('lucide-circle-question-mark')
    expect(answerRow!.cls).not.toMatch(/\btext-pending\b/)
    expect(answerRow!.anim).toBe('none')
    // The icon's stroke and the summary dot resolve to the same amber token.
    expect(answerRow!.stroke).toBe(answer!.bg)
    expect(failedRow!.color).not.toBe(answer!.bg)
    browser.screenshot(`${artifactsDir}/closed-steps-answer-rail.png`, { viewport: true })
  })

  it('an idle-closed run: an orange dot and pause (#2022)', () => {
    openThread(IDLE.id)
    expect(headerPill()).toContain('closed · idle')

    const [, failed, idle] = dots()
    expect(idle!.visual).toBe('idle')
    expect(idle!.bg).not.toBe(failed!.bg)

    expandRail()
    const [, failedRow, idleRow] = rows()
    expect(failedRow!.cls).toContain('lucide-circle-x')
    expect(idleRow!.cls).toContain('lucide-circle-pause')
    expect(idleRow!.color).toBe(idle!.bg)
    browser.screenshot(`${artifactsDir}/closed-steps-idle-rail.png`, { viewport: true })
  })

  it('a plain failure keeps both red Xs', () => {
    openThread(FAILED.id)
    expect(headerPill()).toContain('failed')
    expect(dots().map((d) => d.visual)).toEqual(['done', 'failed', 'failed'])
    expandRail()
    expect(rows().map((r) => r.cls.includes('lucide-circle-x'))).toEqual([false, true, true])
  })
})

describe('the Graph tab on a run that closed without failing', () => {
  it('a run closed on an unanswered question: a still "needs you" node, the earlier failure stays red (#2025)', () => {
    openGraph(ANSWER.id)
    const { tests, fix } = graphNodes()
    expect(fix).toMatchObject({ status: 'answer', label: 'needs you', dotAnim: 'none' })
    expect(tests).toMatchObject({ status: 'failed', label: 'failed' })
    expect(fix!.dotBg).not.toBe(tests!.dotBg)
    // Before the details panel opens: it would cover the node's status dot.
    browser.screenshot(`${artifactsDir}/closed-steps-answer-graph.png`, { viewport: true })
    const details = nodeDetails('fix')
    expect(details).toContain('needs you')
    expect(details).not.toContain('failed')
  })

  it('an idle-closed run: an orange "closed · idle" node (#2024)', () => {
    openGraph(IDLE.id)
    const { tests, fix } = graphNodes()
    expect(fix).toMatchObject({ status: 'idle', label: 'closed · idle' })
    expect(tests!.status).toBe('failed')
    expect(fix!.dotBg).not.toBe(tests!.dotBg)
    browser.screenshot(`${artifactsDir}/closed-steps-idle-graph.png`, { viewport: true })
    expect(nodeDetails('fix')).toContain('closed · idle')
  })

  it('a plain failure keeps its red "failed" node', () => {
    openGraph(FAILED.id)
    const { tests, fix } = graphNodes()
    expect(fix).toMatchObject({ status: 'failed', label: 'failed' })
    expect(fix!.dotBg).toBe(tests!.dotBg)
  })
})
