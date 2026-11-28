import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/thread-run.record.json'

/**
 * A reclaimed task's Changes tab (spec 2026-11-19-worktree-disk-usage), in a real browser: the
 * worktree directory is gone, its branch is kept and `worktreeReclaimedAt` is stamped — what
 * retention leaves. The tab shows the branch's committed diff under a notice, and "Restore
 * worktree" brings the tree back and the live view with it.
 *
 * `CEZ_E2E_SHOTS=<dir>` keeps the before/after screenshots (the PR's evidence).
 */

const sessionId = `e2e-reclaimed-changes-${process.pid}`
const RUN_ID = 'dddddddd-3333-4444-8555-eeeeeeeeffff'
const BRANCH = `cez/${RUN_ID.slice(0, 8)}`
const shots = process.env.CEZ_E2E_SHOTS ? resolve(process.env.CEZ_E2E_SHOTS) : undefined

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let worktree: string
let baseUrl: string

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

/** The repo with `main` and a task branch two files past it — and no checkout of that branch. */
function buildRepo(dir: string): void {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=cezar e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      stdio: 'ignore',
    })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# demo\n\nA small project.\n')
  writeFileSync(join(dir, '.gitignore'), '.ai/\n.cez-home/\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', BRANCH)
  writeFileSync(join(dir, 'README.md'), '# demo\n\nA small project.\n\n## Usage\n\nRun `demo --help`.\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/greet.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Add usage and greet()')
  git('checkout', '-q', 'main')
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-reclaimed-'))
  buildRepo(dataRoot)
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  worktree = join(dataRoot, '.ai/cezar/worktrees', RUN_ID)

  const run = {
    ...record,
    id: RUN_ID,
    title: 'Document usage and add a greeter',
    titleSummary: 'Usage docs and greeter',
    task: 'Document usage and add greet().',
    status: 'done',
    worktreePath: worktree,
    branch: BRANCH,
    baseBranch: 'main',
    worktreeReclaimedAt: '2026-11-20T09:00:00.000Z',
    steps: [record.steps[0]],
    pullRequestUrl: undefined,
  }
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([run], null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/tasks/${RUN_ID}/changes`)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="diff-file"]').length === 2`)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  try {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* the OS reaps it */
  }
})

describe('the Changes tab of a reclaimed task', () => {
  it('shows the kept branch diff under the reclaimed notice', () => {
    expect(existsSync(worktree)).toBe(false)
    expect(browser.text('[data-slot="reclaimed-worktree-notice"]')).toContain(`committed changes on ${BRANCH}`)
    expect(browser.isVisible('[data-slot="restore-worktree"]')).toBe(true)
    expect(browser.text('[data-slot="diff-pane"]')).toContain('greet')
    if (shots) {
      mkdirSync(shots, { recursive: true })
      browser.screenshot(join(shots, 'reclaimed-changes-before.png'), { viewport: true })
    }
  }, 60_000)

  it('Restore worktree brings the tree back and the live view with it', () => {
    browser.click('[data-slot="restore-worktree"]')
    browser.waitForFunction(`document.querySelector('[data-slot="reclaimed-worktree-notice"]') === null`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="diff-file"]').length === 2`)
    expect(existsSync(join(worktree, 'src/greet.ts'))).toBe(true)
    if (shots) browser.screenshot(join(shots, 'reclaimed-changes-after.png'), { viewport: true })
  }, 60_000)
})
