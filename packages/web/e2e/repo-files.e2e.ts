import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * The Git tab's Files segment (spec `.ai/specs/2026-10-05-repo-file-browser.md`, #1279) end-to-end
 * against the shared dry-run environment — which serves THIS repository, so every assertion reads
 * live git state rather than assuming it: the index comes from `GET /api/v1/repo/tree` at test
 * time, and the files opened are picked out of that answer.
 *
 * Strictly READ-ONLY — there is no write path to exercise. The deep-link, markdown-toggle, filter
 * and keyboard behaviours are pinned against fixtures in `src/routes/repo-git/repo-git.test.tsx`;
 * what this spec adds is that the real routes, the real Shiki bundle and the real index agree.
 *
 * **Not a merge gate.** Per `.ai/` history this browser suite runs in no CI workflow, so a green
 * pipeline says nothing about it. Written for local and QA execution (`npm run test:e2e`).
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-repo-files-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 }

let browser: AgentBrowser
let baseUrl: string
let bootProject: string

const scoped = (path: string) => `/p/${bootProject}${path}`

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

interface RepoTreePayload {
  paths: string[]
  truncated: boolean
}

let tree: RepoTreePayload

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  tree = await api<RepoTreePayload>('/api/v1/repo/tree')
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
})

/** The shortest path whose extension is in `exts` — shortest so the filter query stays unambiguous. */
function pickFile(exts: string[]): string {
  const matches = tree.paths.filter((path) => exts.some((ext) => path.toLowerCase().endsWith(ext)))
  return [...matches].sort((a, b) => a.length - b.length)[0] ?? ''
}

describe('the repository Files tab against the live dry-run server', () => {
  it('lists the real index behind one /repo/tree read, with ignored paths absent', async () => {
    expect(tree.paths.length).toBeGreaterThan(0)
    // The feature's whole premise: git's own view, so build output never shows up.
    expect(tree.paths.some((path) => path.startsWith('node_modules/'))).toBe(false)

    browser.goto(`${baseUrl}${scoped('/git/files')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-files-tree"]') !== null`)

    // Folders closed, so the rendered rows stay in the dozens however large the index is.
    expect(browser.count('[data-slot="repo-files-dir"][data-state="open"]')).toBe(0)
    expect(browser.count('[data-slot="repo-files-dir"]')).toBeGreaterThan(0)
    expect(browser.count('[data-slot="repo-files-file"]')).toBeLessThan(tree.paths.length)

    browser.screenshot(`${artifactsDir}/repo-files-desktop.png`)
  })

  it('filters to a file the current diff does not contain and opens it highlighted', async () => {
    const target = pickFile(['.ts', '.tsx'])
    expect(target).not.toBe('')

    browser.goto(`${baseUrl}${scoped('/git/files')}`)
    browser.waitForFunction(`document.querySelector('[data-slot="repo-files-filter"]') !== null`)

    // Type the whole path: a subsequence of itself, so it always matches, and the result list is
    // small enough to click without guessing.
    browser.fill('[data-slot="repo-files-filter"]', target)
    browser.waitForFunction(
      `document.querySelector('[data-slot="repo-files-file"][data-path="${target}"]') !== null`,
    )
    browser.click(`[data-slot="repo-files-file"][data-path="${target}"]`)

    // The URL IS the file, and the real Shiki bundle tokenized it.
    browser.waitForFunction(`document.querySelector('[data-slot="file-preview-code"]') !== null`)
    expect(browser.url()).toBe(`${baseUrl}${scoped(`/git/files/${target}`)}`)
    expect(browser.text('[data-slot="file-preview-head"]')).toContain(target)
    expect(
      browser.evaluate(`document.querySelector('[data-slot="file-preview-code"]').dataset.lang`),
    ).not.toBe('plaintext')
    expect(
      browser.evaluate(
        `document.querySelectorAll('[data-slot="file-preview-code"] span[style*="color"]').length > 0`,
      ),
    ).toBe(true)

    browser.screenshot(`${artifactsDir}/repo-files-viewer.png`)
  })

  it('opens a .md file rendered, and the toggle shows its source', async () => {
    const target = pickFile(['.md'])
    expect(target).not.toBe('')

    browser.goto(`${baseUrl}${scoped(`/git/files/${target}`)}`)
    browser.waitForFunction(`document.querySelector('[data-slot="file-preview-markdown"]') !== null`)
    // Rendered means real elements, not the raw source.
    expect(
      browser.evaluate(
        `document.querySelectorAll('[data-slot="file-preview-markdown"] :is(h1,h2,h3,p,ul,ol,table)').length > 0`,
      ),
    ).toBe(true)

    browser.click('[data-slot="markdown-view-toggle"] [data-mode="source"]')
    browser.waitForFunction(`document.querySelector('[data-slot="file-preview-code"]') !== null`)
    browser.click('[data-slot="markdown-view-toggle"] [data-mode="rendered"]')
    browser.waitForFunction(`document.querySelector('[data-slot="file-preview-markdown"]') !== null`)

    browser.screenshot(`${artifactsDir}/repo-files-markdown.png`)
  })

  it('refuses a path the index does not list, in the server’s own words', async () => {
    const res = await fetch(`${baseUrl}/api/v1/repo/files?path=node_modules/.package-lock.json`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('not in the repository index')
  })

  it('below md the tree is the view until a file is picked, and a back control returns to it', async () => {
    const target = pickFile(['.md'])
    browser.setViewport(IPHONE.width, IPHONE.height)
    try {
      browser.goto(`${baseUrl}${scoped('/git/files')}`)
      // Unlike the Changes views, the tree must NOT be hidden on phones — it is the only way in.
      browser.waitForFunction(
        `(() => { const el = document.querySelector('[data-slot="repo-files-tree"]'); return el !== null && el.offsetParent !== null })()`,
      )
      expect(browser.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true)

      browser.goto(`${baseUrl}${scoped(`/git/files/${target}`)}`)
      browser.waitForFunction(
        `(() => { const el = document.querySelector('[data-slot="repo-files-back"]'); return el !== null && el.offsetParent !== null })()`,
      )
      browser.click('[data-slot="repo-files-back"]')
      browser.waitForFunction(
        `(() => { const el = document.querySelector('[data-slot="repo-files-tree"]'); return el !== null && el.offsetParent !== null })()`,
      )

      browser.screenshot(`${artifactsDir}/repo-files-iphone.png`)
    } finally {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
    }
  })
})
