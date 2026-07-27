import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * The R7 iOS sweep (spec step 21): every primary view at an iPhone viewport (390×844 CSS px),
 * against the shared dry-run environment. Per view this asserts the three things a phone user
 * cannot live without and a desktop-run suite never notices:
 *
 *   1. no horizontal overflow — `document.documentElement.scrollWidth <= window.innerWidth`
 *      (a page that scrolls sideways on a phone is broken, whatever else works);
 *   2. the mobile chrome is reachable — the top bar's drawer menu button exists and is visible,
 *      because below `md` it is the ONLY way to the nav;
 *   3. a screenshot into the e2e artifacts dir, so a checkpoint reviewer sees what an iPhone sees.
 *
 * The drawer's own behavior (open/close/navigate/overflow-while-open) is smoke.e2e.ts territory
 * and is not re-proven here — this file is about every VIEW fitting the phone, not the chrome.
 *
 * Degradation matrix — only the honestly reachable states run live; the rest are already pinned:
 *   - forge OFF: github.e2e.ts's gating spec asserts whichever branch the LIVE health payload
 *     reports (nav item present iff available), and the structural forge-off branches (hidden
 *     nav item, unavailable explainer) are pinned by the unit suites (nav-items/app-shell/
 *     command-palette tests, github.test.tsx). Here `/github` runs only when the live health
 *     payload reports the forge available — same gate as github.e2e.ts.
 *   - no web/dist: the built-in "run `npm run build:web`" hint page is pinned by the unit tests
 *     on `resolveIndexHtml` (src/server/static-ui.test.ts, R7 Step 1.1). Booting a second,
 *     dist-less environment here would re-prove a pure function — not worth a live spec.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-ios-${process.pid}`

const IPHONE = { width: 390, height: 844 } // iPhone 14/15 CSS pixels

/** The one entry point to navigation below `md` (see app-shell.tsx MobileTopBar). */
const MENU_BUTTON = '[data-slot="mobile-top-bar"] button[aria-label="Open menu"]'

let browser: AgentBrowser
let baseUrl: string
let forgeAvailable = false
/** The task-thread view's subject — an existing run when the env has one, else a dry run
 *  started (and settled) by this spec. */
let threadRunId: string

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`)
  if (!res.ok) throw new Error(`cezar e2e: GET ${path} answered ${res.status}`)
  return (await res.json()) as T
}

interface RunRecord {
  id: string
  status: string
  createdAt: string
  archived?: boolean
}

async function waitForStatus(id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await api<RunRecord>(`/api/runs/${id}`)
    if (wanted.includes(record.status)) return record.status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = (await api<{ forge: { available: boolean } | null }>('/api/health'))
  forgeAvailable = health.forge?.available === true

  // The thread view needs a run. Prefer whatever the shared env already holds (newest live
  // record); only when the list is empty does this spec start one dry run — and then settles it
  // via /finish, so the shared env is never left holding an open session another spec would
  // trip over. The run lands in `.ai/cezar/` (gitignored runtime state), same class of shared-env
  // write as the smoke spec's todos.json.
  const runs = await api<RunRecord[]>('/api/runs')
  const existing = [...runs]
    .filter((r) => !r.archived)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (existing) {
    threadRunId = existing.id
  } else {
    const created = (await (
      await fetch(`${baseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 'Say hello to the iOS sweep.', workflow: 'quick-task' }),
      })
    ).json()) as { id: string }
    threadRunId = created.id
    // The dry-run mock's reply carries no CEZ:DONE marker, so the run parks at `waiting`.
    const status = await waitForStatus(threadRunId, ['waiting', 'review', 'done', 'failed'])
    if (status === 'waiting') {
      await fetch(`${baseUrl}/api/runs/${threadRunId}/finish`, { method: 'POST' })
      await waitForStatus(threadRunId, ['review', 'done', 'failed'])
    }
  }

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(IPHONE.width, IPHONE.height)
}, 180_000)

afterAll(() => {
  browser?.close()
})

/** One view's sweep: settle it, then assert the three phone invariants and shoot it.
 *  `ready` waits on real view content (not just the route div) because the lazy routes render
 *  a loading skeleton under the same `data-route` — sampling that would measure the wrong page. */
function sweep(slug: string, path: string, ready: string): void {
  browser.goto(baseUrl + path)
  browser.waitForFunction(`document.querySelector(${JSON.stringify(ready)}) !== null`)

  // The mobile chrome is reachable: the drawer trigger is there and visible — below `md` it is
  // the only way to the nav, so its absence strands the user on whatever view they deep-linked.
  expect(browser.count(MENU_BUTTON)).toBe(1)
  expect(browser.isVisible(MENU_BUTTON)).toBe(true)

  // `<=`, not `===`: the document may be narrower than the viewport, never wider.
  const [scrollWidth, innerWidth] = browser.evaluate(
    `[document.documentElement.scrollWidth, window.innerWidth]`,
  ) as [number, number]
  expect(scrollWidth, `${path} overflows the iPhone viewport horizontally`).toBeLessThanOrEqual(
    innerWidth,
  )

  // Viewport capture, not full-page: the sweep documents what an iPhone frame shows, and
  // full-page stitching is pathological on the virtualized thread (see agent-browser.ts).
  browser.screenshot(`${artifactsDir}/ios-${slug}.png`, { viewport: true })
}

describe('iOS sweep — every primary view at 390×844', () => {
  it('/ (tasks overview)', () => {
    // Ready = the overview answered /api/runs: the cards/table for a filled list, the empty
    // state otherwise — both are real content, either settles the view.
    sweep('tasks', '/', '[data-slot="tasks-table"], [data-slot="task-cards"], [data-slot="tasks-empty"]')
  })

  it('/inbox', () => {
    sweep('inbox', '/inbox', '[data-slot="todo-card"], [data-route="inbox"] [data-slot="centered-state"]')
  })

  it('/git (repo changes)', () => {
    sweep('git', '/git', '[data-slot="repo-header"]')
  })

  it('/github (forge-gated, like github.e2e.ts)', () => {
    // Forge OFF is not reachable in this env — the gate itself is asserted live in
    // github.e2e.ts and structurally in the unit suites (see the header comment).
    if (!forgeAvailable) return
    sweep('github', '/github', '[data-slot="gh-header"]')
  })

  it('/workflows (builder)', () => {
    sweep('workflows', '/workflows', '[data-slot="wb-main"]')
  })

  // Global settings live outside `/p/:projectId` (step 3.5) — swept at their real URLs.
  it('/settings/global/appearance', () => {
    sweep('settings-appearance', '/settings/global/appearance', '[data-route="settings-global-appearance"]')
  })

  it('/settings/skills', () => {
    // The route div renders around a "Loading…" list — wait for a real skill row (this repo's
    // `.ai/skills` is never empty), so the overflow check measures actual content.
    sweep('settings-skills', '/settings/skills', '[data-slot="skill-row"]')
  })

  it('/settings/agents', () => {
    sweep('settings-agents', '/settings/agents', '[data-route="settings-agents"]')
  })

  it('/settings/global/notifications', () => {
    sweep(
      'settings-notifications',
      '/settings/global/notifications',
      '[data-route="settings-global-notifications"]',
    )
  })

  it('/new (full-screen composer)', () => {
    sweep('new', '/new', '[data-route="new"]')
  })

  it('/tasks/:id (task thread)', () => {
    // The dock (composer area) renders only in the settled thread view, never in the
    // loading skeleton — so waiting on it means the transcript pipe has answered.
    sweep('task-thread', `/tasks/${threadRunId}`, '[data-slot="thread-dock"]')
  })
})
