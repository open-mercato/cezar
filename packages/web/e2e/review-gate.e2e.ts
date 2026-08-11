import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The review gate (R3 Step 2.2) end-to-end, against a LIVE dry run — cezar's core promise
 * that nothing auto-merges, walked in full: the mock claude's first turn touches `notes.md`
 * in the run's REAL worktree, so finishing the waiting session parks the run at `review`
 * (the settleSuccess rule). This spec then does what a reviewer does: reads the banner and
 * the real worktree diff, sends notes back (which must land in the same session — the
 * transcript grows with the `Review feedback:` bubble), lets the run gate again, and accepts
 * — run done, celebration fired, banner gone.
 *
 * Draft PR success/409 stays in the component tests: even under CEZ_DRY_RUN the endpoint's
 * failure modes are gh-dependent, and the semantics are fully pinned there.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-review-${process.pid}`

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
  throw new Error(`cezar e2e: the review-gate server never answered at ${url}`)
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as { status: string }
    if (wanted.includes(record.status)) return record.status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let runId: string

beforeAll(async () => {
  // A REAL git repo — the engine creates a worktree, and the mock's notes.md write in it is
  // what gives this spec a genuine non-empty diff (and therefore the review parking).
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-review-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# review-gate e2e fixture repo\n', 'utf8')
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

  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Improve the project notes.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id

  // Park the run at review: the mock's turn leaves the session open (`waiting`), and the
  // finish settles it as `review` because the worktree diff is non-empty (notes.md).
  await waitForStatus(baseUrl, runId, ['waiting'])
  await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
  const parked = await waitForStatus(baseUrl, runId, ['review', 'done'])
  if (parked !== 'review') throw new Error('cezar e2e: the dry run settled as done — no diff to review?')

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

describe('the review gate against a live parked run', () => {
  it('shows the banner and the real worktree diff as per-file sections', () => {
    expect(browser.text('[data-slot="review-banner"]')).toContain(
      'Review the changes before anything lands',
    )
    // The diff is REAL — the mock touched notes.md in the worktree, and it renders as an
    // added-file section with add-tinted lines.
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"]') !== null`)
    expect(browser.text('[data-slot="diff-file-path"]')).toContain('notes.md')
    expect(browser.text('[data-slot="diff-file"]')).toContain('added')
    expect(
      browser.count('[data-slot="diff-file-body"] .bg-diff-add'),
    ).toBeGreaterThanOrEqual(1)
    // All three exits are offered; nothing has merged anything. The dry-run mock prints a PR
    // This fixture deliberately has no PR URL, so the third exit is the deterministic Draft PR
    // action. The post-creation PR-link state and duplicate guard are component-tested.
    expect(browser.isVisible('[data-slot="review-send-back"]')).toBe(true)
    expect(browser.count('[data-slot="review-panel"] [data-slot="pr-link"]')).toBe(0)
    expect(browser.isVisible('[data-slot="review-draft-pr"]')).toBe(true)
    expect(browser.isVisible('[data-slot="review-accept"]')).toBe(true)
    // The panel sits below the transcript in an inner scroll region — bring it into the
    // viewport so the capture shows the review surface, not the top of the thread.
    browser.evaluate(`document.querySelector('[data-slot="review-banner"]').scrollIntoView() ?? true`)
    browser.screenshot(`${artifactsDir}/review-gate-desktop.png`)
  })

  it('reads well on an iPhone viewport', () => {
    browser.setViewport(390, 844)
    browser.waitForFunction(`document.querySelector('[data-slot="review-banner"]') !== null`)
    expect(browser.isVisible('[data-slot="review-notes"]')).toBe(true)
    browser.evaluate(`document.querySelector('[data-slot="review-banner"]').scrollIntoView() ?? true`)
    browser.screenshot(`${artifactsDir}/review-gate-iphone.png`)
    browser.setViewport(1440, 900)
  })

  it('Send back delivers the notes into the SAME session — the transcript grows', async () => {
    browser.fill('[data-slot="review-notes"]', 'Please also mention the port in the notes.')
    browser.click('[data-slot="review-send-back"]')

    // The run leaves review and works again (legacy continue semantics)…
    await waitForStatus(baseUrl, runId, ['running', 'waiting'])
    // …and the feedback itself shows up in the thread as the continuation's user message.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="user-bubble"]')].some((el) =>
         el.textContent.includes('Review feedback:') &&
         el.textContent.includes('Please also mention the port'))`,
    )
    // The panel is gone while the agent works — the gate exists only at `review`.
    browser.waitForFunction(`document.querySelector('[data-slot="review-panel"]') === null`)
  }, 90_000)

  it('the run gates again after the follow-up turn, with a fresh diff', async () => {
    await waitForStatus(baseUrl, runId, ['waiting'])
    await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
    await waitForStatus(baseUrl, runId, ['review'])
    // Re-entry re-renders the panel AND refetches the diff (legacy reload-on-entry parity).
    browser.waitForFunction(`document.querySelector('[data-slot="review-panel"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"]') !== null`)
    expect(browser.text('[data-slot="diff-file-path"]')).toContain('notes.md')
  }, 90_000)

  it('✓ Accept finishes the run as done and fires the one-shot celebration', async () => {
    // The overlay lives ~1.5s — watch for it with an observer armed BEFORE the click, so the
    // assertion cannot lose a race against its own polling.
    browser.evaluate(`(() => {
      window.__cezCelebrated = false
      new MutationObserver(() => {
        if (document.querySelector('[data-slot="accept-celebration"]')) window.__cezCelebrated = true
      }).observe(document.body, { childList: true, subtree: true })
      return true
    })()`)
    // Since 2.4 the thread is a pinned chat surface: content that is merely NEAR the bottom
    // can sit in the band the sticky composer dock floats over. Scroll fully down so the
    // accept row is clear of it, like a reader would.
    browser.evaluate(
      `(() => { const m = document.querySelector('[data-slot="main"]'); m.scrollTop = m.scrollHeight })()`,
    )
    browser.click('[data-slot="review-accept"]')

    await waitForStatus(baseUrl, runId, ['done'])
    browser.waitForFunction(`window.__cezCelebrated === true`)
    browser.screenshot(`${artifactsDir}/review-accepted.png`)

    // The gate is closed: banner gone, the footer reads as a closed session.
    browser.waitForFunction(`document.querySelector('[data-slot="review-panel"]') === null`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="thread-footer"]')?.textContent.includes('Session closed')`,
    )
  }, 90_000)
})
