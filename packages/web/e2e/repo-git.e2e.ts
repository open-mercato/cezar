import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * The repo view (R5 Step 1.7) end-to-end against the shared dry-run environment — which
 * serves THIS repository, so every assertion is against real git state, read at test time
 * rather than assumed: the working tree may be clean or dirty (both are honest states the
 * view must render), the log is whatever this checkout's history is, and the branch list is
 * live. Strictly READ-ONLY: no branch creation, no switching, no commits — the mutation
 * flows (switch/create incl. 409 reasons, base-branch picker) are pinned in
 * `src/routes/repo-git/repo-git.test.tsx` against fixtures.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-repo-git-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 }

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

interface RepoPayload {
  info: { branch: string } | null
  log: Array<{ hash: string; subject: string }>
  branches: string[]
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
})

describe('the repo view against the live dry-run server', () => {
  it('/git renders the header from live git state and an honest Changes segment', async () => {
    const repo = await api<RepoPayload>('/api/repo')
    expect(repo.info).not.toBeNull()

    browser.goto(`${baseUrl}${scoped('/git')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-header"]') !== null`)

    // The branch chip carries the REAL current branch, not a fixture.
    browser.waitForFunction(`document.querySelector('[data-slot="branch-chip"]') !== null`)
    expect(browser.text('[data-slot="branch-chip"]')).toContain(repo.info?.branch ?? '')

    // Three segment tabs, Changes active.
    expect(browser.count('[data-slot="repo-tabs"] a')).toBe(3)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="repo-tabs"] a[aria-current="page"]').getAttribute('href')`,
      ),
    ).toBe(scoped('/git'))

    // The working tree may be clean or dirty — assert the view tells the same story the API does.
    const changes = await api<{ files: unknown[] }>('/api/repo/changes')
    if (changes.files.length === 0) {
      browser.waitForFunction(
        `[...document.querySelectorAll('[data-slot="repo-changes"] h2')].some((h) => h.textContent === 'Working tree clean')`,
      )
    } else {
      browser.waitForFunction(
        `document.querySelectorAll('[data-slot="diff-file"]').length === ${changes.files.length}`,
      )
      expect(browser.count('[data-slot="changes-tree"]')).toBe(1)
    }

    browser.screenshot(`${artifactsDir}/repo-git-desktop.png`)
  })

  it('/git/commits lists this repository’s real commits', async () => {
    const repo = await api<RepoPayload>('/api/repo')
    expect(repo.log.length).toBeGreaterThan(0)

    browser.goto(`${baseUrl}${scoped('/git/commits')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-commits"]') !== null`)

    expect(browser.count('[data-slot="commit-row"]')).toBe(repo.log.length)
    const first = repo.log[0]!
    const firstRow = browser.text(`[data-slot="commit-row"][data-sha="${first.hash}"]`)
    expect(firstRow).toContain(first.hash)
    expect(firstRow).toContain(first.subject)
  })

  it('opens one commit’s structured diff (a non-merge commit, found honestly)', async () => {
    // Merge commits honestly answer zero files — pick the newest commit that carries a diff.
    const repo = await api<RepoPayload>('/api/repo')
    let picked: { hash: string; subject: string; files: Array<{ path: string }> } | null = null
    for (const entry of repo.log) {
      const commit = await api<{ subject: string; files: Array<{ path: string }> }>(
        `/api/repo/commit/${entry.hash}?structured=1`,
      )
      if (commit.files.length > 0) {
        picked = { hash: entry.hash, subject: commit.subject, files: commit.files }
        break
      }
    }
    expect(picked).not.toBeNull()
    if (!picked) return

    browser.goto(`${baseUrl}${scoped('/git/commits')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="commit-row"]') !== null`)
    browser.click(`[data-slot="commit-row"][data-sha="${picked.hash}"]`)

    browser.waitForFunction(`document.querySelector('[data-slot="commit-meta"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/git/commits/${picked.hash}`)}`)
    expect(browser.text('[data-slot="commit-meta"]')).toContain(picked.subject)
    // The same <Diff> facade, one card per changed file.
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="diff-file"]').length === ${picked.files.length}`,
    )
    // The way back is a link.
    expect(
      browser.evaluate(`document.querySelector('[data-slot="commit-back"]').getAttribute('href')`),
    ).toBe(scoped('/git/commits'))

    browser.screenshot(`${artifactsDir}/repo-git-commit.png`)
  })

  it('/git/branches renders the live branch list with the checkout marked current', async () => {
    const repo = await api<RepoPayload>('/api/repo')
    expect(repo.branches.length).toBeGreaterThan(0)

    browser.goto(`${baseUrl}${scoped('/git/branches')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-branch-list"]') !== null`)

    expect(browser.count('[data-slot="branch-row"]')).toBe(repo.branches.length)
    // An attached checkout marks exactly its current branch. CI may run this suite from a
    // detached task worktree; then git honestly reports no branch and no row may be marked.
    const expectedCurrent = repo.info?.branch && repo.branches.includes(repo.info.branch) ? 1 : 0
    expect(browser.count('[data-slot="branch-current"]')).toBe(expectedCurrent)
    if (expectedCurrent === 1 && repo.info) {
      expect(
        browser.evaluate(
          `document.querySelector('[data-slot="branch-current"]').closest('[data-slot="branch-row"]').dataset.branch`,
        ),
      ).toBe(repo.info.branch)
    }
    // The base-branch picker exists — /api/repo carries baseBranch, so the control is honest.
    expect(browser.count('[data-slot="base-branch-picker"]')).toBe(1)
  })

  it('below md the repo view forces unified+wrap, hides the toggles, and never overflows', async () => {
    browser.setViewport(IPHONE.width, IPHONE.height)
    try {
      const changes = await api<{ files: unknown[] }>('/api/repo/changes')
      browser.goto(`${baseUrl}${scoped('/git')}`)
      browser.waitForFunction(`document.querySelector('[data-slot="repo-changes"]') !== null`)

      if (changes.files.length > 0) {
        browser.waitForFunction(`document.querySelector('[data-slot="diff"]') !== null`)
        // Forced mobile combination, whatever the desktop toggles said.
        expect(browser.evaluate(`document.querySelector('[data-slot="diff"]').dataset.mode`)).toBe('unified')
        // The tree column yields to the diff on phones.
        expect(
          browser.evaluate(
            `(() => { const el = document.querySelector('[data-slot="changes-tree"]'); return el === null || el.offsetParent === null })()`,
          ),
        ).toBe(true)
      } else {
        browser.waitForFunction(
          `[...document.querySelectorAll('[data-slot="repo-changes"] h2')].some((h) => h.textContent === 'Working tree clean')`,
        )
      }
      // The mode/wrap toggles are hidden below md (`md:flex` wrapper).
      expect(
        browser.evaluate(
          `getComputedStyle(document.querySelector('[data-slot="diff-mode-toggle"]').parentElement).display`,
        ),
      ).toBe('none')
      // The segments stay a tappable row and the page never scrolls sideways.
      expect(browser.count('[data-slot="repo-tabs"] a')).toBe(3)
      expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

      browser.screenshot(`${artifactsDir}/repo-git-iphone.png`)
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
    }
  })
})
