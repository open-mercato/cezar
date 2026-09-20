import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * The `gemini` runner (#581, spec 2026-09-19-runner-seam-native-backends Phase 2 Step 7) end to end
 * on a LIVE dry run: under CEZ_DRY_RUN=1 cezar drives the bundled `mock-gemini-acp.mjs`, whose
 * frames mirror the real `gemini --acp` wire. A task started on gemini must reach review with a
 * real worktree diff, render its tool calls and diff in the thread, and a follow-up must resume the
 * SAME Gemini session (`session/load`) rather than start a new one — without re-rendering the
 * history the agent replays on load.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-gemini-${process.pid}`

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
  throw new Error(`cezar e2e: the gemini server never answered at ${url}`)
}

interface RunView {
  status: string
  runner?: string
  steps: Array<{ sessionId?: string; backend?: string }>
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<RunView> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await getJson<RunView>(`${url}/api/v1/runs/${id}`)
    if (wanted.includes(record.status)) return record
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let runId: string
let firstSession: string | undefined

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-gemini-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# gemini e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    // The review gate is opt-in (#489); pinning it makes "reaches review" reproducible.
    { env: fixtureServeEnv(dataRoot, { CEZ_REVIEW_GATE: '1' }), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Improve the project notes.', workflow: 'quick-task', runner: 'gemini' }),
    })
  ).json()) as { id: string }
  runId = created.id

  const waiting = await waitForStatus(baseUrl, runId, ['waiting'])
  firstSession = waiting.steps.find((step) => step.sessionId)?.sessionId
  await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
  const parked = await waitForStatus(baseUrl, runId, ['review', 'done'])
  if (parked.status !== 'review') throw new Error('cezar e2e: the gemini dry run settled as done — no diff to review?')

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/tasks/${runId}`)
  browser.waitForFunction(`document.querySelector('[data-slot="review-panel"]') !== null`)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('a task on the gemini runner (dry run)', () => {
  it('is recorded as a gemini run with a Gemini session id', async () => {
    const run = await getJson<RunView>(`${baseUrl}/api/v1/runs/${runId}`)
    expect(run.runner).toBe('gemini')
    expect(run.steps.some((step) => step.backend === 'gemini')).toBe(true)
    expect(firstSession).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reaches review with the real worktree diff the agent wrote', () => {
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"]') !== null`)
    expect(browser.text('[data-slot="diff-file-path"]')).toContain('notes.md')
    expect(browser.text('[data-slot="review-banner"]')).toContain('Review the changes before anything lands')
    browser.evaluate(`document.querySelector('[data-slot="review-banner"]').scrollIntoView() ?? true`)
    browser.screenshot(`${artifactsDir}/gemini-review.png`)
  })

  it('renders the agent’s answer in the thread', () => {
    browser.waitForFunction(
      `document.body.textContent.includes('Investigating: Improve the project notes.')`,
    )
  })

  it('a follow-up resumes the SAME Gemini session, without re-rendering the replayed history', async () => {
    browser.fill('[data-slot="review-notes"]', 'Please also mention the port in the notes.')
    browser.click('[data-slot="review-send-back"]')
    const resumed = await waitForStatus(baseUrl, runId, ['waiting'])

    const sessions = resumed.steps.map((step) => step.sessionId).filter(Boolean)
    expect(new Set(sessions)).toEqual(new Set([firstSession]))
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="user-bubble"]')].some((el) =>
         el.textContent.includes('Review feedback:'))`,
    )
    // The mock replays "an earlier answer" on session/load, exactly as Gemini replays history;
    // cezar already has that history and must not show it twice.
    expect(browser.evaluate(`document.body.textContent.includes('an earlier answer')`)).toBe(false)
    browser.screenshot(`${artifactsDir}/gemini-follow-up.png`)
  }, 90_000)
})
