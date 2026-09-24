import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, getJson } from './agent-browser'

/**
 * The full-screen /new composer (R4 Steps 1.1 + 1.3) end-to-end against a LIVE dry-run server:
 * client navigation from the sidebar CTA reaches the React hero, the cmdk source dropdown lists
 * this repo's project skills first, picking one + typing + submitting starts a real run — and
 * the API readback pins the created run to the exact skill-chain shape plus the persisted
 * `lastTask`. The second describe proves the protected bookmarklet contract (spec 011,
 * BACKWARD_COMPATIBILITY.md) on full document loads of /new, with the REAL launch key read
 * from `.ai/cezar/launch-key` — the documented on-disk contract.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-new-task-${process.pid}`

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
  throw new Error(`cezar e2e: the new-task server never answered at ${url}`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2) —
 *  what the cockpit's own links and its post-submit navigations actually spell. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  // A REAL git repo: the run needs a worktree, and the base-branch pill needs branches.
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-new-task-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# new-task e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // TWO project skills, so the spec can prove an actual PICK (not just the default): the
  // picker defaults to the first project skill, then we choose the other one.
  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/skills/lint-fix.md'),
    '---\ndescription: Fix lint findings in the changed files\n---\n\nRun the linter and fix everything it reports.\n',
    'utf8',
  )
  writeFileSync(
    join(dataRoot, '.ai/skills/spec-writer.md'),
    '---\ndescription: Draft a feature spec from a one-line idea\n---\n\nWrite the spec.\n',
    'utf8',
  )

  // One real workflow file, so the picker has a Workflows group to render: the built-in
  // `quick-task` is not a row of its own any more (it IS the "No skill" row), and a fixture with
  // only the built-in would leave the group empty for reasons that have nothing to do with the
  // grouping under test.
  mkdirSync(join(dataRoot, '.ai/cezar/workflows'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/cezar/workflows/fix-and-verify.yaml'),
    'name: fix-and-verify\ndescription: Fix, then prove it with the tests\nskills:\n  - lint-fix\n',
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

describe('the full-screen /new against a live dry-run server', () => {
  it('the sidebar CTA client-navigates to the React hero, focus already in the textarea', () => {
    browser.goto(`${baseUrl}${scoped('/')}`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="sidebar"] a[href="${scoped('/new')}"]') !== null`,
    )
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped('/new')}`)
    expect(browser.text('h1')).toBe('What should the agent work on?')
    expect(browser.isVisible('[data-slot="twinkle-backdrop"]')).toBe(true)
    expect(
      browser.evaluate(
        `document.activeElement === document.querySelector('[data-slot="composer"] textarea')`,
      ),
    ).toBe(true)
    expect(browser.count('[data-slot="suggested-chip"]')).toBe(3)
  })

  it('the pill row resolves: no source picked, runner pill iff >1 backend, base: main, ×1', async () => {
    // Sources are ready once the pill stops showing its loading ellipsis. A resolved composer
    // picks NOTHING — the empty state is the default, so there is no name to wait for.
    browser.waitForFunction(
      `!document.querySelector('[data-slot="source-pill"]')?.textContent.includes('…')`,
    )
    expect(browser.evaluate(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind`,
    )).toBe('none')
    // Health must have SETTLED before judging the runner pill — the version chip renders from
    // the same response, so it is the "health arrived" signal.
    browser.waitForFunction(`document.querySelector('[data-slot="version-chip"]') !== null`)
    // The rule under test is legacy's: pill iff the HOST offers >1 backend. The host's own
    // CLIs are what they are (codex/opencode may genuinely be installed here), so assert
    // consistency with the live health answer rather than assuming a bare machine.
    const health = (await (await fetch(`${baseUrl}/api/v1/health`)).json()) as {
      checks: Array<{ name: string; available: boolean }>
    }
    const runners = ['claude', 'codex', 'opencode'].filter((id) =>
      health.checks.some((c) => c.name === id && c.available),
    )
    if (runners.length > 1) {
      expect(browser.count('[data-slot="runner-pill"]')).toBe(1)
      expect(browser.text('[data-slot="runner-pill"]')).toContain('claude')
    } else {
      expect(browser.count('[data-slot="runner-pill"]')).toBe(0)
    }
    // Same rule as the runner pill above, for the same reason: the model pill shows the HOST's
    // native default when the installed agent pins one (`readAgentModelDefaults` seeds
    // `defaultModels` from the agent's own settings), and `auto` only when it does not. Asserting
    // `auto` unconditionally failed on any machine whose claude settings name a model.
    const config = await getJson<{ defaultModels?: Record<string, string> }>(
      `${baseUrl}/api/v1/config`,
    )
    expect(browser.text('[data-slot="model-pill"]')).toContain(config.defaultModels?.claude || 'auto')
    expect(browser.text('[data-slot="variants-pill"]')).toContain('×1')
    expect(browser.text('[data-slot="base-pill"]')).toContain('base: main')
    browser.screenshot(`${artifactsDir}/new-task-hero.png`)
  })

  it('the source dropdown groups project skills first and picking one updates the pill', () => {
    browser.click('[data-slot="source-pill"]')
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
    const groups = browser.evaluate(`[...document.querySelectorAll('[cmdk-group-heading]')].map(h => h.textContent)`) as string[]
    expect(groups[0]).toBe('Project skills')
    expect(groups).toContain('Workflows')
    // The first row is the heading-less way out of any selection, and the built-in it runs has
    // no second row under Workflows.
    expect(browser.evaluate(
      `[...document.querySelectorAll('[data-slot="source-option"]')][0]?.textContent`,
    )).toContain('No skill')
    expect(browser.count('[data-slot="source-option"][data-source-ref="quick-task"]')).toBe(0)
    const skillRefs = browser.evaluate(
      `[...document.querySelectorAll('[data-slot="source-option"][data-source-kind="skill"]')].map(o => o.dataset.sourceRef)`,
    ) as string[]
    // The fixture's own two skills, in #377 order. Asserted by their relative order rather than
    // by being the first two rows: a machine whose shared team-skill cache is populated
    // (`getTeamSkillsCached`, global and unrelated to this repo) lists those here too, and they
    // must not decide an assertion about the fixture's grouping.
    expect(skillRefs.filter((ref) => ref === 'lint-fix' || ref === 'spec-writer')).toEqual([
      'lint-fix',
      'spec-writer',
    ])
    browser.screenshot(`${artifactsDir}/new-task-source-menu.png`)

    browser.click('[data-slot="source-option"][data-source-ref="spec-writer"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]').textContent.includes('spec-writer')`,
    )
    browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') === null`)
  })

  it('the ✕ takes the picked skill back off, and the selected row toggles it off too', () => {
    // One click, no menu — the affordance the report asked for.
    browser.click('[data-slot="source-pill-clear"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind === 'none'`,
    )
    // Nothing picked, nothing to clear: the ✕ is gone with the selection.
    expect(browser.count('[data-slot="source-pill-clear"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/new-task-source-empty.png`)

    // The same state from inside the list: pick it, then pick it again.
    const pickSpecWriter = () => {
      browser.click('[data-slot="source-pill"]')
      browser.waitForFunction(`document.querySelector('[data-slot="source-menu"]') !== null`)
      browser.click('[data-slot="source-option"][data-source-ref="spec-writer"]')
    }
    pickSpecWriter()
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('spec-writer')`,
    )
    pickSpecWriter()
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind === 'none'`,
    )

    // Leave it picked: the next spec submits from here.
    pickSpecWriter()
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('spec-writer')`,
    )
  })

  it('type + submit → the thread; the run record carries the exact skill chain', async () => {
    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', 'Draft a spec for the new-task hero e2e.')
    browser.click('[aria-label="Start task"]')
    browser.waitForFunction(`location.pathname.startsWith('${scoped('/tasks/')}')`)

    const runId = (browser.evaluate(`location.pathname.split('/').pop()`) as string) ?? ''
    expect(runId).not.toBe('')
    // API readback: the run started from the PICKED skill, as the one-step inline chain.
    const record = await getJson<{
      task: string
      workflowDef?: { steps?: Array<Record<string, unknown>> }
    }>(`${baseUrl}/api/v1/runs/${runId}`)
    expect(record.task).toBe('Draft a spec for the new-task hero e2e.')
    expect(record.workflowDef?.steps).toEqual([
      expect.objectContaining({ id: 'task', name: 'spec-writer', skill: 'spec-writer', prompt: '{{task}}' }),
    ])

    // The source is recorded as lastTask — a record of what ran, not a preselection for the
    // next task (see the next spec, and `resolveSource`).
    const uiState = await getJson<{ lastTask?: { source: string; ref: string } | null }>(
      `${baseUrl}/api/v1/ui-state`,
    )
    expect(uiState.lastTask).toEqual({ source: 'skill', ref: 'spec-writer' })

    // The thread really rendered (the run parks at waiting under the dry-run mock).
    browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)
  }, 90_000)

  it('back on /new the skill is gone with the task it ran; iPhone hero screenshot', () => {
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    // The started skill does NOT follow the user into the next task — the whole point of the
    // empty state. A fresh composer picks nothing and shows the invitation. Waiting on the
    // label rather than the kind: an unpicked pill reports `none` while still loading, and a
    // "does not contain spec-writer" assertion would pass against the ellipsis for free.
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('Skill')`,
    )
    expect(browser.evaluate(
      `document.querySelector('[data-slot="source-pill"]')?.dataset.sourceKind`,
    )).toBe('none')
    expect(
      browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').value`),
    ).toBe('')

    browser.setViewport(390, 844)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    browser.screenshot(`${artifactsDir}/new-task-hero-iphone.png`, { viewport: true })
    browser.setViewport(1440, 900)
  })
})

describe('the bookmarklet contract on full /new loads (spec 011, Step 1.3)', () => {
  const runCount = async (): Promise<number> =>
    (await getJson<unknown[]>(`${baseUrl}/api/v1/runs`)).length

  it('auto=1 with the REAL launch key starts a run unattended and lands in its thread', async () => {
    // The documented on-disk contract: the server bakes this secret into the bookmarklets it
    // generates; only a page holding it may start runs. Read it exactly where users can.
    const key = readFileSync(join(dataRoot, '.ai/cezar/launch-key'), 'utf8').trim()
    expect(key).not.toBe('')
    const before = await runCount()

    browser.goto(
      `${baseUrl}/new?skill=lint-fix&ref=hello&auto=1&key=${encodeURIComponent(key)}`,
    )
    // Unattended: no clicks from here — the cockpit takes us to the thread by itself.
    browser.waitForFunction(`location.pathname.startsWith('${scoped('/tasks/')}')`)

    const runId = (browser.evaluate(`location.pathname.split('/').pop()`) as string) ?? ''
    const record = await getJson<{
      task: string
      workflowDef?: { steps?: Array<Record<string, unknown>> }
    }>(`${baseUrl}/api/v1/runs/${runId}`)
    expect(record.task).toBe('hello')
    expect(record.workflowDef?.steps).toEqual([
      expect.objectContaining({ id: 'task', name: 'lint-fix', skill: 'lint-fix', prompt: '{{task}}' }),
    ])
    expect(await runCount()).toBe(before + 1)
  }, 90_000)

  it('a wrong key only prefills — the composer, a toast, and NOT one run more', async () => {
    const before = await runCount()

    browser.goto(`${baseUrl}/new?skill=lint-fix&ref=hello&auto=1&key=definitely-wrong`)
    browser.waitForFunction(`document.querySelector('[data-route="new"] [data-slot="composer"]') !== null`)

    // Prefilled, blocked, and honest about it.
    expect(browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').value`)).toBe('hello')
    browser.waitForFunction(
      `document.querySelector('[data-slot="source-pill"]')?.textContent.includes('lint-fix')`,
    )
    browser.waitForFunction(`document.querySelector('[data-slot="toast"]') !== null`)
    expect(browser.text('[data-slot="toast"]')).toContain('Auto-start blocked')
    browser.screenshot(`${artifactsDir}/new-task-bookmarklet-blocked.png`)

    // The key (right or wrong) never survives in the URL, and no run started.
    browser.waitForFunction(`location.search === ''`)
    // The legacy flat `/new?…` the bookmarklet grammar guarantees landed on the scoped twin —
    // the redirect BACKWARD_COMPATIBILITY.md's bookmarklet contract now rests on.
    expect(browser.url()).toBe(`${baseUrl}${scoped('/new')}`)
    expect(await runCount()).toBe(before)
  }, 90_000)

  it('/new?legacy=1 serves the React shell on this server too — the hatch retired in R7', () => {
    browser.goto(`${baseUrl}/new?legacy=1`)
    browser.waitForFunction(`document.getElementById('root') !== null`)
    expect(browser.evaluate(`document.getElementById('brand') === null`)).toBe(true)
  })
})
