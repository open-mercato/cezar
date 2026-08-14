import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The Changes tab (R5 Step 1.5) end-to-end against a LIVE dry run, same doctrine as
 * review-gate.e2e.ts: the mock claude's first turn appends `notes.md` in the run's REAL
 * worktree, so `/api/v1/runs/:id/changes` answers a genuine one-file diff (the diff is anchored
 * at the merge-base, so it survives the engine's settle-time autosave commit). The fixture
 * repo carries a github.com `origin`, so the forge resolves (dry-run `detect()` answers
 * available without the network) and the git surface is fully lit.
 *
 * What the dry-run backend honestly provides — verified, not assumed:
 *  - the fixture has no PR URL, so the toolbar deterministically offers Create PR. The
 *    create → View PR transition is pinned in task-changes.test.tsx.
 *  - the settle autosave leaves the worktree clean; the Commit test dirties it again from
 *    the outside (as a user editing in the worktree would) so the commit is REAL.
 *
 * Also not covered here, on purpose: the "No changes yet" empty state (every dry run touches
 * notes.md — unreachable live; unit-tested), and Push (the fake remote would stall on ssh
 * auth; the policy rules are pinned in git-actions.test.ts).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-changes-${process.pid}`

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
  throw new Error(`cezar e2e: the changes-tab server never answered at ${url}`)
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
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

let runId: string
let worktreePath: string

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-changes-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# changes-tab e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')
  // A github.com remote makes `resolveForge` return the GitHub driver; under CEZ_DRY_RUN its
  // detect() answers available without touching the network. Nothing ever pushes to it.
  git('remote', 'add', 'origin', 'git@github.com:acme/changes-e2e.git')

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
      body: JSON.stringify({ task: 'Improve the project notes.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id

  // Park the run at review (the same settle rule review-gate.e2e.ts rides): the worktree
  // diff is non-empty because the mock touched notes.md.
  await waitForStatus(baseUrl, runId, ['waiting'])
  await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
  const parked = await waitForStatus(baseUrl, runId, ['review', 'done'])
  if (parked !== 'review') throw new Error('cezar e2e: the dry run settled as done — no diff to review?')

  const record = (await (await fetch(`${baseUrl}/api/v1/runs/${runId}`)).json()) as { worktreePath: string }
  worktreePath = record.worktreePath

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) {
    server.kill()
    await once(server, 'exit')
  }
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('the Changes tab against a live dry run', () => {
  it('the Session header tab navigates to /changes: tree, toolbar and the real diff', () => {
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="run-tabs"]') !== null`)
    browser.click(`[data-slot="run-tabs"] a[href="${scoped(`/tasks/${runId}/changes`)}"]`)

    // Client-side navigation into the lazy chunk — wait for the toolbar to exist.
    browser.waitForFunction(`document.querySelector('[data-slot="git-toolbar"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/tasks/${runId}/changes`)}`)

    // The Changes tab is the active one now.
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="run-tabs"] a[aria-current="page"]').textContent`,
      ),
    ).toBe('Changes')

    // The tree shows the mock's real change: notes.md, one added line.
    browser.waitForFunction(`document.querySelector('[data-slot="changes-tree"]') !== null`)
    const fileRow = browser.evaluate(
      `document.querySelector('[data-slot="tree-file"][data-path="notes.md"]').textContent`,
    ) as string
    expect(fileRow).toContain('notes.md')
    expect(fileRow).toContain('+1')

    // The diff facade renders the same file (engine chunk is lazy — wait).
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"][data-path="notes.md"]') !== null`)
    // The aggregate stat agrees.
    expect(browser.text('[data-slot="changes-stat"]')).toContain('+1')
  })

  it('the toolbar comes from the policy: Push, Create PR, Commit, and kebab', () => {
    // Push's enablement rides the /api/v1/health answer (repo.remote), and health probes the
    // real codex/opencode/gh CLIs — slow. Wait for the policy to settle rather than sample.
    browser.waitForFunction(
      `document.querySelector('[data-slot="git-toolbar"] [data-action="push"]')?.disabled === false`,
    )
    const actions = browser.evaluate(`[...document.querySelectorAll('[data-slot="git-toolbar"] [data-action]')]
      .map((el) => ({ id: el.dataset.action, disabled: el.disabled === true }))`) as Array<{
      id: string
      disabled: boolean
    }>
    expect(actions).toEqual([
      { id: 'push', disabled: false },
      { id: 'create-pr', disabled: false },
      { id: 'commit', disabled: false },
    ])
    // Terminal handoff is capability-gated and covered against both states in component tests;
    // this fixture pins only the primary policy actions.
    // The branch chip names the run's real branch.
    expect(browser.text('[data-slot="git-toolbar"] [data-slot="branch-chip"]')).toContain('cez/')

    browser.screenshot(`${artifactsDir}/changes-desktop.png`)
  })

  it('deep-linking /tasks/:id/changes cold-loads the same surface', () => {
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/changes`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"][data-path="notes.md"]') !== null`)
    expect(browser.count('[data-route="task-changes"]')).toBe(1)
    expect(browser.count('[data-slot="changes-tree"]')).toBe(1)
  })

  it('Commit: the dialog prefills the auto-summary, commits for real in the worktree', () => {
    // The settle autosave left the tree clean — dirty it the way a user editing in the
    // worktree would, so the commit below has something real to commit.
    writeFileSync(join(worktreePath, 'edited-by-e2e.md'), 'a change made outside the agent\n', 'utf8')

    browser.click('[data-slot="git-toolbar"] [data-action="commit"]')
    // Radix dialog animates in — wait for the textarea, then check the prefill.
    browser.waitForFunction(`document.querySelector('[data-slot="commit-message"]') !== null`)
    const prefill = browser.evaluate(
      `document.querySelector('[data-slot="commit-message"]').value`,
    ) as string
    expect(prefill.length).toBeGreaterThan(0)

    browser.fill('[data-slot="commit-message"]', 'docs: notes touched by the changes e2e')
    browser.click('[data-slot="commit-confirm"]')
    // Success closes the dialog (a 409 would keep it open — that path is unit-tested).
    browser.waitForFunction(`document.querySelector('[data-slot="commit-message"]') === null`)

    // The commit is REAL — read it back from the run's worktree.
    const subject = execFileSync('git', ['-C', worktreePath, 'log', '-1', '--format=%s'], {
      encoding: 'utf8',
    }).trim()
    expect(subject).toBe('docs: notes touched by the changes e2e')

    // The diff stays anchored at the merge-base, so the committed changes still show —
    // now including the file this test added.
    browser.waitForFunction(`document.querySelector('[data-slot="diff-file"][data-path="notes.md"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="tree-file"][data-path="edited-by-e2e.md"]') !== null`)
  })

  it('the Files tab opens the worktree browser under the same header (deep coverage: task-files.e2e.ts)', () => {
    browser.click(`[data-slot="run-tabs"] a[href="${scoped(`/tasks/${runId}/files`)}"]`)
    browser.waitForFunction(`document.querySelector('[data-route="task-files"] [data-slot="files-tree"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/tasks/${runId}/files`)}`)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="run-tabs"] a[aria-current="page"]').textContent`,
      ),
    ).toBe('Files')
  })

  it('below md the segments stay tappable and the diff forces unified+wrap (toggles gone)', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/changes`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="diff"]') !== null`)

    // Forced mobile combination, no matter what the desktop toggles said.
    expect(browser.evaluate(`document.querySelector('[data-slot="diff"]').dataset.mode`)).toBe('unified')
    // The mode/wrap toggles are hidden below md (`md:flex`).
    expect(
      browser.evaluate(
        `getComputedStyle(document.querySelector('[data-slot="diff-mode-toggle"]').parentElement).display`,
      ),
    ).toBe('none')
    // The tree column yields to the diff on phones.
    expect(
      browser.evaluate(
        `(() => { const el = document.querySelector('[data-slot="changes-tree"]'); return el === null || el.offsetParent === null })()`,
      ),
    ).toBe(true)
    // The tabs remain a tappable segment row and the page does not overflow sideways.
    // Session / Changes / Commits / Files — the whole row survives the phone framing.
    expect(browser.count('[data-slot="run-tabs"] a')).toBe(4)
    expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

    browser.screenshot(`${artifactsDir}/changes-mobile.png`)
    browser.setViewport(1440, 900)
  })
})
