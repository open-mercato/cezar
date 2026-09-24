import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * Plan mode end-to-end (R4 Step 1.2, #383 + spec 008) against a LIVE dry-run server. Under
 * CEZ_DRY_RUN the planner runs the bundled mock CLI, which answers `[cez-planner]` calls with a
 * DETERMINISTIC 3-step chain (Implement / Verify `npm test` / Review — whose made-up
 * `code-review` skill the sanitizer strips, leaving the prompt). So the whole loop is provable
 * without tokens: toggle → plan → review overlay → save-as-chain (+409 overwrite) → edit →
 * ▶ Start → the run's record carries the EXACT edited steps.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-plan-mode-${process.pid}`

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
  throw new Error(`cezar e2e: the plan-mode server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  // A real git repo — ▶ Start creates a worktree for the planned run.
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-plan-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# plan-mode e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')
  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/skills/lint-fix.md'),
    '---\ndescription: Fix lint findings\n---\n\nRun the linter and fix everything.\n',
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

const stepIdsJs = `[...document.querySelectorAll('[data-slot="plan-step"]')].map((el) => el.dataset.stepId)`
const stepOrder = () => browser.evaluate(`${stepIdsJs}.join()`) as string

/**
 * Click a step-card control (↑/↓/✕) and require the order it must produce. Retries the CLICK
 * only while the order is provably UNCHANGED: agent-browser occasionally computes the click
 * point against a mid-reflow layout (observed after viewport flips — the pointerdown landed on
 * the list's gap, the click on body), and a click that landed nowhere is safe to repeat. A
 * click that changed the order to anything but `expected` still fails loudly.
 */
async function clickStepControl(selector: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = stepOrder()
    browser.click(selector)
    for (let poll = 0; poll < 20; poll += 1) {
      await new Promise((r) => setTimeout(r, 100))
      const now = stepOrder()
      if (now !== before) {
        expect(now).toBe(expected)
        return
      }
    }
  }
  throw new Error(`cezar e2e: ${selector} never changed the step order`)
}

describe('plan mode against a live dry-run server', () => {
  it('Plan first selects visibly (#383) and submit produces the review overlay, not a run', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"] a[href="${scoped('/new')}"]') !== null`)
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    browser.waitForFunction(`document.querySelector('[data-slot="mode-plan"]') !== null`)
    // Sources must have LOADED before submitting — a plan submit races the workflows/skills
    // queries otherwise and is (correctly) rejected with the "still loading" toast. The pill
    // dropping its loading ellipsis is the ready signal (same trick as new-task.e2e): a
    // resolved composer picks nothing, so there is no name to wait for.
    browser.waitForFunction(
      `!document.querySelector('[data-slot="source-pill"]')?.textContent.includes('…')`,
    )

    expect(browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`)).toBe('false')
    browser.click('[data-slot="mode-plan"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked') === 'true'`,
    )
    // The unmistakable selected state: the segment took the contrast fill (mockup .plan-active).
    expect(
      browser.evaluate(
        `getComputedStyle(document.querySelector('[data-slot="mode-plan"]')).backgroundColor ===
         getComputedStyle(document.documentElement).getPropertyValue('--contrast') ||
         document.querySelector('[data-slot="mode-plan"]').className.includes('bg-contrast')`,
      ),
    ).toBe(true)

    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', 'Tighten the flaky suite end to end.')
    browser.click('[aria-label="Plan task"]')

    // The overlay arrives with the mock planner's canned chain; no run was started.
    browser.waitForFunction(`document.querySelector('[data-slot="plan-review"]') !== null`)
    expect(browser.evaluate(stepIdsJs)).toEqual(['implement', 'verify', 'review'])
    expect(browser.text('[data-slot="plan-task"]')).toBe('Tighten the flaky suite end to end.')
    expect(browser.text('[data-slot="plan-rationale"]')).toContain('Implement, verify with tests')
    expect(browser.count('[data-slot="plan-fallback"]')).toBe(0)
    expect(browser.count('[data-slot="plan-badge-check"]')).toBe(1)
    browser.screenshot(`${artifactsDir}/plan-overlay.png`)
  }, 90_000)

  it('save as chain lands in /api/v1/workflows; saving again asks before overwriting', async () => {
    browser.click('[data-slot="plan-save"]')
    browser.waitForFunction(`document.querySelector('[data-slot="plan-save-dialog"]') !== null`)
    browser.fill('[aria-label="Chain name"]', 'e2e planned chain')
    browser.click('[data-slot="plan-save-dialog"] button[type="submit"]')
    browser.waitForFunction(`document.querySelector('[data-slot="plan-save-dialog"]') === null`)

    const readback = await getJson<{
      workflows: Array<{ name: string; source: string; steps: Array<{ id: string }> }>
    }>(`${baseUrl}/api/v1/workflows`)
    const saved = readback.workflows.find((w) => w.name === 'e2e planned chain')
    expect(saved?.source).toBe('file')
    expect(saved?.steps.map((s) => s.id)).toEqual(['implement', 'verify', 'review'])

    // Same name again → 409 → the overwrite confirm → Yes retries with overwrite.
    browser.click('[data-slot="plan-save"]')
    browser.waitForFunction(`document.querySelector('[data-slot="plan-save-dialog"]') !== null`)
    browser.fill('[aria-label="Chain name"]', 'e2e planned chain')
    browser.click('[data-slot="plan-save-dialog"] button[type="submit"]')
    browser.waitForFunction(`document.querySelector('[data-slot="plan-overwrite-dialog"]') !== null`)
    browser.click('[data-slot="plan-overwrite-dialog"] [data-slot="alert-dialog-action"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="plan-overwrite-dialog"]') === null &&
       document.querySelector('[data-slot="plan-save-dialog"]') === null`,
    )
    const again = await getJson<{ workflows: Array<{ name: string }> }>(
      `${baseUrl}/api/v1/workflows`,
    )
    expect(again.workflows.filter((w) => w.name === 'e2e planned chain')).toHaveLength(1)
  }, 90_000)

  it('on an iPhone the overlay is a full-screen sheet and the ↑/↓ buttons still reorder', async () => {
    browser.setViewport(390, 844)
    // The reflow must LAND before anything measures or clicks: a click computed against the
    // pre-resize layout dispatches into the gap between cards and silently does nothing.
    browser.waitForFunction(
      `window.innerWidth === 390 &&
       document.querySelector('[data-slot="plan-review"]')?.getBoundingClientRect().width > 380`,
    )
    // Rounded: Radix's zoom-in entrance leaves sub-pixel transform residue on the rect.
    const rect = browser.evaluate(
      `(() => { const r = document.querySelector('[data-slot="plan-review"]').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } })()`,
    ) as { x: number; y: number; w: number }
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(0)
    expect(rect.w).toBe(390)

    // The previous spec's "saved" toast sits over the step cards at this width — 360px of
    // pointer-events-auto across a 390px viewport. It expires on its own; the reorder below
    // clicks exactly where it lands, so wait it out rather than click through it.
    browser.waitForFunction(`document.querySelector('[data-slot="toast"]') === null`)

    // Touch-honest reorder: buttons, not drag.
    await clickStepControl(
      '[data-slot="plan-step"]:nth-of-type(1) [data-slot="plan-step-down"]',
      'verify,implement,review',
    )
    await clickStepControl(
      '[data-slot="plan-step"]:nth-of-type(2) [data-slot="plan-step-up"]',
      'implement,verify,review',
    )
    // Captured AFTER the interactions: a shot taken in the same beat as the viewport flip can
    // catch a stale compositor frame (the pre-resize layout) even though the DOM is settled.
    browser.screenshot(`${artifactsDir}/plan-overlay-iphone.png`, { viewport: true })
  })

  it('remove + reorder shape the chain; ▶ Start posts those EXACT inline steps and opens the thread', async () => {
    // Desktop again — restored HERE (not at the end of the mobile spec) so a mid-spec failure
    // there can never strand the rest of the file on a phone viewport. The overlay re-centering
    // (x > 0) is the proof the desktop reflow landed — clicks against the stale mobile layout
    // dispatch into the gaps between cards and silently miss (observed, not hypothetical).
    browser.setViewport(1440, 900)
    browser.waitForFunction(
      `window.innerWidth === 1440 &&
       document.querySelector('[data-slot="plan-review"]')?.getBoundingClientRect().x > 100`,
    )
    // Drop the `npm test` check (the fixture repo has no package.json) and put Review first.
    await clickStepControl(
      '[data-slot="plan-step"]:nth-of-type(2) [data-slot="plan-step-remove"]',
      'implement,review',
    )
    await clickStepControl(
      '[data-slot="plan-step"]:nth-of-type(2) [data-slot="plan-step-up"]',
      'review,implement',
    )

    browser.click('[data-slot="plan-start"]')
    browser.waitForFunction(`location.pathname.startsWith('${scoped('/tasks/')}')`)

    const runId = (browser.evaluate(`location.pathname.split('/').pop()`) as string) ?? ''
    expect(runId).not.toBe('')
    const record = (await (await fetch(`${baseUrl}/api/v1/runs/${runId}`)).json()) as {
      task: string
      workflowDef?: { steps?: Array<Record<string, unknown>> }
    }
    expect(record.task).toBe('Tighten the flaky suite end to end.')
    expect(record.workflowDef?.steps).toEqual([
      expect.objectContaining({ id: 'review', name: 'Review', prompt: 'Review the changes for {{task}}' }),
      expect.objectContaining({ id: 'implement', name: 'Implement', prompt: '{{task}}' }),
    ])
    // The thread really rendered (the dry-run session parks at waiting).
    browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)
  }, 90_000)

  it('back on /new: plan mode stuck (draft store) and the spent draft text is gone', () => {
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    browser.waitForFunction(`document.querySelector('[data-slot="mode-plan"]') !== null`)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="mode-plan"]').getAttribute('aria-checked')`),
    ).toBe('true')
    expect(browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').value`)).toBe('')
  })
})
