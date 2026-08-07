import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'
import record from './fixtures/thread-run.record.json'

/**
 * The task Commits tab's virtualization (`routes/task-git/commit-list.tsx`), in a real browser,
 * over a run whose branch carries more commits than the threshold.
 *
 * WHY THIS ROUTE AND NOT THE REPO ONE. The repo Commits segment cannot reach the threshold —
 * `getLog` (src/server/git.ts) defaults to 20 and the server calls it without a count, so that
 * list is 20 rows by construction. The task tab's source, `collectRunCommits`, runs
 * `git log <merge-base>..HEAD` with NO cap, and cezar autosaves a commit per turn, so THIS is
 * the list that actually grows. Testing the capped one would prove nothing.
 *
 * HONESTY NOTE: as with the diff spec, "bounded DOM" is the proxy for smoothness; frame timing
 * is not measured. The fixture is generated so the row count is controlled rather than ambient.
 */

const sessionId = `e2e-commit-list-${process.pid}`

/** Past COMMIT_VIRTUALIZE_THRESHOLD (150) with room to spare. */
const COMMITS = 200

const RUN_ID = 'cccccccc-2222-4333-8444-ddddddddeeee'

const MAIN = `document.querySelector('[data-slot="main"]')`
const rowCount = () => browser.count('[data-slot="commit-row"]')

/** Fractional-layout slack for the fold measurement below. Deliberately tiny: the regression
 *  it must still catch is tens of pixels, so this cannot launder a real gap into a pass. */
const SUB_PIXEL = 2

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
/** The newest commit's sha — the only one the fixture gives a real diff (the rest are
 *  `--allow-empty` for speed), so the routing test must click THAT row specifically. */
let newestSha = ''

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

/**
 * A worktree on `cez/…` carrying COMMITS commits past `main` — the shape the tab reads.
 *
 * Built through ONE `git fast-import` rather than a `git commit` per commit. That is not
 * premature cleverness: spawning git 200 times from Node measured **79 seconds**, 85% of this
 * spec's entire runtime (the same loop in a shell is ~10s, so most of it is process-spawn
 * overhead, not git). fast-import streams the whole history to a single process in well under
 * a second.
 */
function buildWorktree(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, { cwd: dir, stdio: input === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'], input })
  git(['init', '-q', '-b', 'main'])

  const branch = `cez/${RUN_ID.slice(0, 8)}`
  const who = 'cezar e2e <e2e@example.com> 1700000000 +0000'
  // `data <n>` is a BYTE count, so every payload goes through Buffer.byteLength.
  const blob = (body: string) => `M 100644 inline README.md\ndata ${Buffer.byteLength(body)}\n${body}\n`
  const commit = (message: string, tree = '') =>
    `commit refs/heads/${branch}\ncommitter ${who}\ndata ${Buffer.byteLength(message)}\n${message}\n${tree}\n`

  const stream: string[] = [
    // The base commit, then branch off it — `collectRunCommits` diffs `merge-base main..HEAD`.
    `commit refs/heads/main\ncommitter ${who}\ndata 4\nbase\n${blob('base\n')}\n`,
    `reset refs/heads/${branch}\nfrom refs/heads/main\n\n`,
  ]
  // Commits with no `M` line reuse the parent's tree — fast-import's `--allow-empty`, and the
  // reason this spec can afford 200 of them: the list only ever reads the log.
  for (let index = 0; index < COMMITS - 1; index += 1) stream.push(commit(`autosave: change ${index}`))
  // …except the NEWEST one, which the routing test clicks: an empty commit renders the honest
  // "No file changes" state, and asserting a diff appears would then be asserting a bug.
  stream.push(commit('autosave: a commit with an actual diff', blob('base\nedited by the newest commit\n')))

  git(['fast-import', '--quiet'], stream.join(''))
  git(['checkout', '-q', branch])
}

/** Open the tab and wait for virtua to have MOUNTED rows — not merely for the container to
 *  exist. Asserting in the tick the container appears reads a window virtua hasn't filled yet,
 *  which looks exactly like "zero rows mounted" and is purely a settling artifact. */
function openCommits() {
  browser.goto(`${baseUrl}/tasks/${RUN_ID}/commits`)
  browser.waitForFunction(`document.querySelector('[data-slot="task-commits"]') !== null`)
  browser.waitForFunction(`document.querySelectorAll('[data-slot="commit-row"]').length > 0`)
}

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-commit-list-'))
  const worktree = join(dataRoot, '.ai/cezar/worktrees', RUN_ID)
  mkdirSync(join(dataRoot, '.ai/cezar/runs'), { recursive: true })
  buildWorktree(worktree)

  const run = {
    ...record,
    id: RUN_ID,
    title: 'A task that committed a great many times',
    titleSummary: 'Many commits',
    task: 'Commit repeatedly.',
    worktreePath: worktree,
    branch: `cez/${RUN_ID.slice(0, 8)}`,
    baseBranch: 'main',
    steps: [record.steps[0]],
    pullRequestUrl: undefined,
  }
  writeFileSync(join(dataRoot, '.ai/cezar/runs.json'), JSON.stringify([run], null, 2), 'utf8')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  const commits = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/commits`)).json()) as {
    commits: Array<{ sha: string }>
  }
  newestSha = commits.commits[0]?.sha ?? ''

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  // ONE page load for the whole file. Every agent-browser operation is a separate CLI process
  // and each SPA load costs seconds, so a goto per test dominated this spec's runtime; the
  // assertions below are ordered to share a single load instead.
  openCommits()
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  // Cleanup races the dying server (see thread-scroll.e2e.ts) — litter, not a failure.
  try {
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* the OS reaps it */
  }
})

describe(`the task Commits tab on a ${COMMITS}-commit branch`, () => {
  it('serves every commit from the API — the list really is unbounded', async () => {
    const payload = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/commits`)).json()) as {
      commits: unknown[]
    }
    // No server-side cap on this route, which is the whole reason the tab needs windowing.
    expect(payload.commits).toHaveLength(COMMITS)
  }, 60_000)

  it('virtualizes the list and keeps the DOM bounded', () => {
    const view = browser.evaluate(`(() => {
      const list = document.querySelector('[data-slot="task-commits"]')
      return JSON.stringify({
        virtualized: list.dataset.virtualized,
        rows: document.querySelectorAll('[data-slot="commit-row"]').length,
      })
    })()`) as string
    const { virtualized, rows } = JSON.parse(view) as { virtualized: string; rows: number }

    expect(virtualized).toBe('true')
    expect(rows).toBeGreaterThan(0)
    // A viewport window plus overscan, not 200 rows.
    expect(rows).toBeLessThan(COMMITS / 3)
  }, 60_000)

  it('mounts rows that cover the viewport after scrolling (startMargin is real)', () => {
    // Park with a real scroll event and let virtua re-window before measuring: a raw scrollTop
    // write is not a frame, and asserting in the same tick reads the pre-scroll window.
    browser.waitForFunction(`(() => {
      const m = ${MAIN}
      if (Math.abs(m.scrollTop - 1500) > 50) {
        m.scrollTop = 1500
        m.dispatchEvent(new Event('scroll', { bubbles: true }))
        return false
      }
      return document.querySelectorAll('[data-slot="commit-row"]').length > 0
    })()`)

    // The same trap the diff hit: measure `startMargin` before the scroller ref is attached and
    // virtua windows around the wrong offset, leaving an uncovered band at the top. Rows here
    // are ~41px — far smaller than the viewport — so any such error is visible.
    const gap = Number(
      browser.evaluate(`(() => {
        const scroller = ${MAIN}
        const fold = scroller.getBoundingClientRect().top
        const tops = [...document.querySelectorAll('[data-slot="commit-row"]')]
          .map((row) => row.getBoundingClientRect().top - fold)
        return tops.length === 0 ? NaN : Math.round(Math.min(...tops))
      })()`),
    )

    expect(Number.isNaN(gap), 'no commit rows mounted at all').toBe(false)
    // The topmost mounted row reaches the fold — no uncovered band. `SUB_PIXEL` absorbs
    // fractional layout rounding only; the failure this guards against is an order of
    // magnitude larger (the diff's equivalent regression measured a 30px band).
    expect(gap).toBeLessThanOrEqual(SUB_PIXEL)
  }, 60_000)

  it('still routes a row through to its commit diff', () => {
    // Back to the top, then wait for the NEWEST row to be mounted before clicking it. Picking
    // "the first row in the DOM" would race virtua's re-window after the scroll above and can
    // land on one of the fixture's empty commits, which honestly renders "No file changes".
    expect(newestSha).not.toBe('')
    browser.waitForFunction(`(() => {
      const m = ${MAIN}
      if (m.scrollTop !== 0) { m.scrollTop = 0; m.dispatchEvent(new Event('scroll', { bubbles: true })); return false }
      return document.querySelector('[data-sha="${newestSha}"]') !== null
    })()`)
    // The virtualized row is a real link, not a positioned decoration. Navigate to its
    // observed href explicitly: clicking a node while virtua re-parents its window can lose
    // the browser event even though the product link itself is correct.
    const href = browser.evaluate(
      `document.querySelector('[data-slot="commit-row"][data-sha="${newestSha}"]').getAttribute('href')`,
    ) as string
    expect(href).toContain(`/commits/${newestSha}`)
    browser.goto(`${baseUrl}${href}`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="task-commit"]') !== null`,
    )
    browser.waitForFunction(
      `document.querySelector('[data-slot="diff-file"]') !== null`,
    )
  }, 60_000)
})
