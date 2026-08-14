import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The variants compare view (R3 Step 2.3) end-to-end, against a LIVE ×2 dry run — spec 010
 * walked in full. Variants REQUIRE a git repo (each runs in its own worktree; the server 400s
 * without one), so this boots the same tmp-repo fixture as review-gate.e2e.ts. The mock claude
 * writes notes.md in each variant's OWN worktree and leaves the session open (`waiting`);
 * finishing each parks it at `review` (the settleSuccess rule) — two settled variants with
 * real, distinct diffs. The spec then does what a chooser does: reads the columns (letters,
 * status, spend, git's own --stat, the Progress excerpt), opens a full diff, and picks A —
 * B is archived with its worktree removed, and the browser lands on A's thread at the gate.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-variants-${process.pid}`

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
  throw new Error(`cezar e2e: the variants server never answered at ${url}`)
}

async function getRun(url: string, id: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as Record<string, unknown>
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await getRun(url, id)
    if (wanted.includes(String(record.status))) return String(record.status)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

let groupId: string
let idA: string
let idB: string

beforeAll(async () => {
  // A REAL git repo — mandatory for variants: the engine isolates each in its own worktree.
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-variants-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# variants e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    // CEZ_REVIEW_GATE=1 because this spec is ABOUT the gate: it is opt-in (#489, default OFF),
    // so pinning it here is what makes the parked-at-review fixture reproducible instead of
    // depending on whatever the operator happens to export.
    { env: fixtureServeEnv(dataRoot, { CEZ_REVIEW_GATE: '1' }), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Improve the project notes.', workflow: 'quick-task', variants: 2 }),
    })
  ).json()) as { runs: Array<{ id: string; variant: string; groupId: string }> }
  expect(created.runs).toHaveLength(2)
  const a = created.runs.find((r) => r.variant === 'A')
  const b = created.runs.find((r) => r.variant === 'B')
  if (!a || !b) throw new Error('cezar e2e: POST /api/v1/runs did not answer variants A and B')
  idA = a.id
  idB = b.id
  groupId = a.groupId

  // Settle BOTH variants: each mock turn touches notes.md in its own worktree and leaves the
  // session open; finishing parks the run at `review` because the worktree diff is non-empty.
  for (const id of [idA, idB]) await waitForStatus(baseUrl, id, ['waiting'])
  for (const id of [idA, idB]) {
    await fetch(`${baseUrl}/api/v1/runs/${id}/finish`, { method: 'POST' })
    const parked = await waitForStatus(baseUrl, id, ['review', 'done'])
    if (parked !== 'review') throw new Error(`cezar e2e: variant ${id} settled as done — no diff?`)
  }

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('the variants compare view against two settled dry runs', () => {
  it('the tasks overview offers the compare strip once every variant is terminal', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="compare-strip"]') !== null`)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="compare-strip"] a')?.getAttribute('href')`,
      ),
    ).toBe(scoped(`/compare/${groupId}`))
  })

  it('renders a column per variant with letter, status, spend, --stat and Progress', () => {
    browser.goto(`${baseUrl}${scoped(`/compare/${groupId}`)}`)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="variant-column"]').length === 2`)

    expect(browser.text('h1')).toContain('Improve the project notes')
    for (const letter of ['A', 'B']) {
      const col = `[data-slot="variant-column"][data-variant="${letter}"]`
      expect(browser.text(`${col} [data-slot="variant-letter"]`)).toBe(letter)
      expect(browser.text(`${col} [data-slot="pill"]`)).toContain('needs review')
      // The mock's notes.md write shows up in git's own --stat words.
      expect(browser.text(`${col} [data-slot="variant-diffstat"]`)).toContain('notes.md')
      // The handoff Progress excerpt the mock appended (spec 007 behavior).
      expect(browser.text(`${col} [data-slot="variant-progress"]`)).toContain('implemented the change')
      // Every variant is terminal, so the CTA is live.
      expect(
        browser.evaluate(`document.querySelector('${col} [data-slot="variant-pick"]').disabled`),
      ).toBe(false)
    }
    browser.screenshot(`${artifactsDir}/variants-compare-desktop.png`)
  })

  it('reads well on an iPhone viewport — the columns stack', () => {
    browser.setViewport(390, 844)
    browser.waitForFunction(`document.querySelectorAll('[data-slot="variant-column"]').length === 2`)
    // Structural stacking proof: at 390px the two columns occupy the same x-range (one per row).
    const stacked = browser.evaluate(`(() => {
      const [a, b] = document.querySelectorAll('[data-slot="variant-column"]')
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return Math.abs(ra.left - rb.left) < 1 && rb.top >= ra.bottom
    })()`)
    expect(stacked).toBe(true)
    browser.screenshot(`${artifactsDir}/variants-compare-iphone.png`)
    browser.setViewport(1440, 900)
  })

  it("expanding a full diff shows the review gate's per-file cards for THAT variant", () => {
    browser.waitForFunction(`document.querySelectorAll('[data-slot="variant-diff"]').length === 2`)
    browser.click(`[data-slot="variant-diff"][data-variant="A"] button`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="variant-diff"][data-variant="A"] [data-slot="diff-file"]') !== null`,
    )
    expect(
      browser.text(`[data-slot="variant-diff"][data-variant="A"] [data-slot="diff-file-path"]`),
    ).toContain('notes.md')
    expect(
      browser.count(`[data-slot="variant-diff"][data-variant="A"] [data-slot="diff-file-body"] .bg-diff-add`),
    ).toBeGreaterThanOrEqual(1)
  })

  it('✔ Pick A confirms, archives B with its worktree removed, and lands on A at the gate', async () => {
    browser.click(`[data-slot="variant-column"][data-variant="A"] [data-slot="variant-pick"]`)
    browser.waitForFunction(`document.querySelector('[data-slot="confirm-pick"]') !== null`)
    browser.click(`[data-slot="confirm-pick"]`)

    // Navigation to the winner's thread, where the review gate renders (A parked at review).
    browser.waitForFunction(`location.pathname === '${scoped(`/tasks/${idA}`)}'`)
    browser.waitForFunction(`document.querySelector('[data-slot="review-panel"]') !== null`)
    browser.screenshot(`${artifactsDir}/variants-compare-picked.png`)

    // The loser: archived, its worktree and branch gone; it was already settled, so its
    // status is untouched — spec 010's pick semantics, asserted against the API.
    const loser = await getRun(baseUrl, idB)
    expect(loser.archived).toBe(true)
    expect(loser.worktreePath).toBeUndefined()
    expect(loser.branch).toBeUndefined()

    // The winner is live, unarchived, at review.
    const winner = await getRun(baseUrl, idA)
    expect(winner.status).toBe('review')
    expect(winner.archived).toBe(false)
  }, 90_000)
})
