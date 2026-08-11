import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The Files tab (R5 Step 1.6) end-to-end against a LIVE dry run, same doctrine as
 * task-changes.e2e.ts: a real fixture repo, a real dry-run worktree, real
 * `GET /api/v1/runs/:id/files` answers. The fixture commits a subdirectory (lazy expansion is
 * observable as a click, not a mock), a TypeScript file (Shiki tokens must actually render),
 * and a REAL 1×1 PNG — so the inline-image path, including the server's `raw=1` byte mode,
 * IS honestly reachable here and covered below (naturalWidth is the proof the bytes decoded).
 *
 * Not covered here, on purpose: the too-large and binary-non-image states (they would need a
 * >512 kB / NUL-byte fixture commit for one CenteredState each — pinned in
 * task-files.test.tsx and git-changes.test.ts instead), and the no-worktree 409 (a dry run
 * always has a worktree; unit-tested).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-files-${process.pid}`

// 1×1 transparent PNG — real bytes so the <img> decode is a real test.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

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
  throw new Error(`cezar e2e: the files-tab server never answered at ${url}`)
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

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-files-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# files-tab e2e fixture repo\n', 'utf8')
  mkdirSync(join(dataRoot, 'src'))
  writeFileSync(join(dataRoot, 'src', 'hello.ts'), "export const greeting = 'hello from the files tab'\n", 'utf8')
  writeFileSync(join(dataRoot, 'logo.png'), PNG)
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
      body: JSON.stringify({ task: 'Improve the project notes.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id

  // Park the run at review — the worktree then holds the fixture tree plus the mock's edit.
  await waitForStatus(baseUrl, runId, ['waiting'])
  await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
  const parked = await waitForStatus(baseUrl, runId, ['review', 'done'])
  if (parked !== 'review') throw new Error('cezar e2e: the dry run settled as done — no worktree to browse?')

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('the Files tab against a live dry-run worktree', () => {
  it('deep-linking /tasks/:id/files renders the root listing and the select-a-file prompt', () => {
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/files`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="files-tree"]') !== null`)

    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="run-tabs"] a[aria-current="page"]').textContent`,
      ),
    ).toBe('Files')
    // The real worktree root: the committed fixture files plus the src dir.
    expect(browser.count('[data-slot="files-file"][data-path="README.md"]')).toBe(1)
    expect(browser.count('[data-slot="files-file"][data-path="logo.png"]')).toBe(1)
    expect(browser.count('[data-slot="files-dir"][data-path="src"]')).toBe(1)
    // Nothing selected yet — the pane is honest about it.
    expect(browser.text('[data-slot="file-preview"]')).toContain('Select a file')
  })

  it('a directory expands lazily and its TypeScript file previews with Shiki tokens', () => {
    // src starts closed — its listing is a second request the click triggers.
    expect(
      browser.evaluate(`document.querySelector('[data-slot="files-dir"][data-path="src"]').dataset.state`),
    ).toBe('closed')
    browser.click('[data-slot="files-dir"][data-path="src"]')
    browser.waitForFunction(`document.querySelector('[data-slot="files-file"][data-path="src/hello.ts"]') !== null`)

    browser.click('[data-slot="files-file"][data-path="src/hello.ts"]')
    browser.waitForFunction(`document.querySelector('[data-slot="file-preview-code"]') !== null`)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="file-preview-code"]').dataset.lang`),
    ).toBe('typescript')
    expect(browser.text('[data-slot="file-preview-code"]')).toContain(
      "export const greeting = 'hello from the files tab'",
    )
    // Highlighted for real: the singleton's grammar chunk loads, then tokens carry --syn-* colors.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="file-preview-code"] span[style]')]
        .some((el) => (el.getAttribute('style') ?? '').includes('var(--syn'))`,
    )
    // The header names the file; the selected row is marked.
    expect(browser.text('[data-slot="file-preview-head"]')).toContain('src/hello.ts')
    expect(browser.count('[data-slot="files-file"][aria-current="true"]')).toBe(1)

    browser.screenshot(`${artifactsDir}/files-desktop.png`)
  })

  it('an image previews inline — the raw=1 bytes really decode', () => {
    browser.click('[data-slot="files-file"][data-path="logo.png"]')
    browser.waitForFunction(`document.querySelector('[data-slot="file-preview-image"]') !== null`)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="file-preview-image"]').getAttribute('src')`),
    ).toBe(`/api/v1/runs/${runId}/files?path=logo.png&raw=1`)
    // naturalWidth is only non-zero once the browser has fetched AND decoded the bytes.
    browser.waitForFunction(
      `document.querySelector('[data-slot="file-preview-image"]').naturalWidth === 1`,
    )
    browser.screenshot(`${artifactsDir}/files-image.png`)
  })

  it('below md the columns stack, the tree stays usable, and nothing overflows sideways', () => {
    browser.setViewport(390, 844)
    browser.goto(`${baseUrl}${scoped(`/tasks/${runId}/files`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="files-tree"]') !== null`)

    // Unlike Changes, the tree must stay visible on phones — it is the only navigation.
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="files-tree"]').offsetParent !== null`,
      ),
    ).toBe(true)
    // Session / Changes / Commits / Files.
    expect(browser.count('[data-slot="run-tabs"] a')).toBe(4)
    expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

    browser.screenshot(`${artifactsDir}/files-mobile.png`)
    browser.setViewport(1440, 900)
  })
})
