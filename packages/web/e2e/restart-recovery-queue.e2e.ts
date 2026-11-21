import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, stopFixtureServer } from './agent-browser'

/**
 * Restart recovery under a lowered concurrency cap (#721, follow-up to #693): three tasks are
 * mid-turn, the workspace `maxParallel` drops 3 → 1, cezar is killed and restarted. Exactly one
 * recovered continuation may run; the other two queue with ordered positions and advance one at
 * a time as each recovered turn finishes.
 *
 * The dry-run Claude mock holds a turn with `mock:slow` (25 s) so all three are in flight at the
 * kill. A recovered continuation resumes with cezar's own restart prompt, which carries no
 * marker, so the second boot scales the mock's cosmetic pauses with `CEZ_MOCK_PACE` to make each
 * recovered turn last long enough to observe the queue.
 *
 * Reachability: fully — own server over a throwaway repo; `CEZ_HOME` lives inside it, so the
 * resource setting is restored (explicitly, in afterAll) and every fixture run deleted without
 * touching the shared test env.
 */

const sessionId = `e2e-restart-recovery-${process.pid}`
const RECOVERED_TURN_PACE = '10'

let browser: AgentBrowser
let server: ChildProcess | undefined
let dataRoot: string
let port: number
let baseUrl: string
let bootProject: string
const runIds: string[] = []

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const p = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(p))
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return
    } catch {
      // Still starting.
    }
    await sleep(250)
  }
  throw new Error(`cezar e2e: the restart-recovery server never answered at ${url}`)
}

async function boot(extra: Record<string, string>): Promise<void> {
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot, extra),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
}

type RunRow = { id: string; status: string; createdAt: string; steps: Array<{ sessionId?: string }> }

async function listRuns(): Promise<RunRow[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await (await fetch(`${baseUrl}/api/v1/runs`)).json()) as RunRow[]
    } catch (error) {
      if (attempt >= 3) throw error
      await sleep(200)
    }
  }
}

async function putMaxParallel(value: number): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/workspace/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resources: { maxParallel: value } }),
  })
  if (!response.ok) throw new Error(`workspace config update failed: ${response.status}`)
}

async function maxParallel(): Promise<number> {
  const config = (await (await fetch(`${baseUrl}/api/v1/workspace/config`)).json()) as {
    resources: { maxParallel: number }
  }
  return config.resources.maxParallel
}

async function startRun(task: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, workflow: 'quick-task' }),
  })
  const created = (await response.json()) as { id: string }
  runIds.push(created.id)
  return created.id
}

/** The persisted index, as a crash would leave it — what recovery actually reads. */
function persistedRuns(): Array<{ id: string; status: string; steps?: Array<{ sessionId?: string }> }> {
  const file = join(dataRoot, '.ai/cezar/runs.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const list = Array.isArray(parsed) ? parsed : (parsed as { runs?: unknown[] }).runs ?? []
    return list as Array<{ id: string; status: string; steps?: Array<{ sessionId?: string }> }>
  } catch {
    return []
  }
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-restart-queue-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# restart recovery fixture\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // Three agent slots to begin with; the spec lowers it to one before the restart.
  const cezHome = join(dataRoot, '.cez-home')
  mkdirSync(cezHome, { recursive: true })
  writeFileSync(join(cezHome, 'config.json'), JSON.stringify({ resources: { maxParallel: 3 } }), 'utf8')

  port = await freePort()
  baseUrl = `http://localhost:${port}`
  await boot({})
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(async () => {
  browser?.close()
  // Restore the resource setting and delete every fixture run while the server is still up; the
  // throwaway dataRoot goes with the server, but the cleanup is part of the scenario.
  if (server && server.exitCode === null) {
    try {
      await putMaxParallel(3)
      for (const id of runIds) await fetch(`${baseUrl}/api/v1/runs/${id}`, { method: 'DELETE' })
    } catch {
      // Best effort: dataRoot is removed below either way.
    }
  }
  const child = server
  server = undefined
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill()
    await exited
  }
  await stopFixtureServer(undefined, dataRoot)
})

describe('restart recovery respects a lowered concurrency cap', () => {
  it('runs exactly one recovered continuation and advances the queue one task at a time', async () => {
    // 1. Three tasks, all mid-turn with an agent session, under maxParallel=3.
    for (const name of ['alpha', 'bravo', 'charlie']) {
      await startRun(`mock:slow restart recovery ${name}`)
      await sleep(300) // distinct createdAt → deterministic recovery order
    }
    const [alpha, bravo, charlie] = runIds
    for (let attempt = 0; ; attempt += 1) {
      const runs = await listRuns()
      if (runs.length === 3 && runs.every((r) => r.status === 'running' && r.steps.some((s) => s.sessionId))) break
      if (attempt > 120) throw new Error('cezar e2e: the three tasks never reached running with a session')
      await sleep(250)
    }

    // 2. Lower the cap, wait until what recovery reads is on disk, then crash the server.
    await putMaxParallel(1)
    expect(await maxParallel()).toBe(1)
    for (let attempt = 0; ; attempt += 1) {
      const persisted = persistedRuns()
      if (persisted.length === 3 && persisted.every((r) => r.status === 'running' && r.steps?.some((s) => s.sessionId))) break
      if (attempt > 60) throw new Error('cezar e2e: runs.json never held the three in-flight tasks')
      await sleep(250)
    }
    const dying = server!
    const exited = new Promise<void>((done) => dying.once('exit', () => done()))
    dying.kill('SIGKILL')
    await exited
    server = undefined

    // 3. Restart; recovered turns are slow enough to observe.
    await boot({ CEZ_MOCK_PACE: RECOVERED_TURN_PACE })
    expect(await maxParallel()).toBe(1)

    // 4. Sample the queue until every task has been through its recovered turn.
    const order = [alpha, bravo, charlie]
    const startedOrder: string[] = []
    let sawOneRunningTwoQueued = false
    let browserChecked = false
    let advanced = false
    const live = new Set(['running', 'queued', 'starting'])
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const runs = (await listRuns()).filter((r) => order.includes(r.id))
      const running = runs.filter((r) => r.status === 'running')
      const queued = runs
        .filter((r) => r.status === 'queued')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      // The invariant under test, at every sample: the lowered cap holds.
      expect(running.length).toBeLessThanOrEqual(1)
      for (const r of running) if (!startedOrder.includes(r.id)) startedOrder.push(r.id)

      if (running.length === 1 && queued.length === 2 && !browserChecked) {
        sawOneRunningTwoQueued = true
        expect(running[0]!.id).toBe(alpha)
        expect(queued.map((r) => r.id)).toEqual([bravo, charlie])
        // The cockpit shows the ordered positions on each queued task's own page.
        for (const [index, run] of queued.entries()) {
          browser.goto(`${baseUrl}/p/${bootProject}/tasks/${run.id}`)
          browser.waitForFunction(`document.querySelector('[data-status]')?.textContent.includes('Queued #${index + 1}')`)
        }
        browserChecked = true
      }
      // The queue moved on by exactly one: bravo has the slot, charlie is next.
      if (running[0]?.id === bravo && queued.length === 1 && queued[0]!.id === charlie) advanced = true
      if (runs.length === 3 && runs.every((r) => !live.has(r.status))) break
      await sleep(250)
    }

    expect(sawOneRunningTwoQueued).toBe(true)
    expect(browserChecked).toBe(true)
    expect(advanced).toBe(true)
    expect(startedOrder).toEqual(order)
    const settled = (await listRuns()).filter((r) => order.includes(r.id))
    expect(settled.every((r) => !live.has(r.status))).toBe(true)
  }, 240_000)
})
