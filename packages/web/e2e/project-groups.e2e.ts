import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'
import { readSharedProjects, snapshotSharedHome, writeSharedProjects } from './workspace-registry'

/**
 * The grouped multi-project sidebar (multi-project spec, "Sidebar" / Step 3.3), end to end.
 *
 * This is the one spec that WANTS more than one registered project: the run's globalSetup pins
 * the shared env to the flat single-project shape, and this file overrides it for its own
 * duration by seeding two throwaway git repos into the registry alongside the boot project.
 * `GET /api/v1/projects` reads the registry per request, so the seed takes effect on the next page
 * load — no server restart — and `afterAll` puts the operator's scratch home back byte for byte.
 *
 * What is worth proving here rather than in `project-groups.test.tsx`: that the registry file,
 * the projects API, the per-project route prefixes and the collapse round-trip through a REAL
 * browser's localStorage (across a real reload) are one working chain. The component's own rules
 * (ordering, missing roots, badge attribution) are pinned in jsdom against fixtures.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-project-groups-${process.pid}`
const repoRoot = resolve(import.meta.dirname, '../../..')

const DESKTOP = { width: 1440, height: 900 }

/** Seeded siblings of the boot project. Ids obey the registry's slug rule (`^[a-z0-9][a-z0-9-]*$`)
 *  and are prefixed so an interrupted run leaves something obviously disposable behind. */
const ALPHA = { id: 'e2e-alpha', name: 'e2e alpha' }
const BETA = { id: 'e2e-beta', name: 'e2e beta' }

let browser: AgentBrowser
let baseUrl: string
let bootProject: string
let seedDir: string
let restoreHome: () => void
let singleProject = false

let forgeAvailable = false
let followupsAvailable = false
let automationsAvailable = false

const scoped = (projectId: string, path: string) => `/p/${projectId}${path}`

/** The nav every group renders — the same health-gated list the flat shell uses. */
/** The project's tab BAND over its views (the sidebar tree carries no per-project nav rows any
 *  more): Skills is the workspace library and Settings rides the bar, so neither is a tab. */
function expectedBandHrefs(projectId: string): string[] {
  return [
    scoped(projectId, '/'),
    ...(followupsAvailable ? [scoped(projectId, '/inbox')] : []),
    scoped(projectId, '/git'),
    ...(forgeAvailable ? [scoped(projectId, '/github')] : []),
    // #801: the automations opt-in is workspace-wide, the forge gate is per project — the item
    // needs both.
    ...(forgeAvailable && automationsAvailable ? [scoped(projectId, '/automations')] : []),
    scoped(projectId, '/workflows'),
  ]
}

/** A real (if empty) git repo, so the registry probe answers `ok` rather than `not-git` and the
 *  group renders its expandable form instead of the "folder not found" row. */
function makeRepo(name: string): string {
  const root = join(seedDir, name)
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore' })
  return root
}

async function workspaceUiState(): Promise<{ sidebar?: { collapsed?: Record<string, boolean> } }> {
  // Retried once: undici's pooled keep-alive socket to the shared env can be minutes idle and
  // answer only ECONNRESET on first reuse.
  const read = async () =>
    (await (await fetch(`${baseUrl}/api/v1/workspace/ui-state`)).json()) as {
      sidebar?: { collapsed?: Record<string, boolean> }
    }
  return read().catch(read)
}

/** The collapse map as THIS browser holds it — the cockpit's own storage since the map stopped
 *  being a workspace-wide setting every client had to share. */
function storedCollapse(): Record<string, boolean> {
  const raw = browser.evaluate(`localStorage.getItem('cez-sidebar-collapsed')`)
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, boolean>) : {}
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json())) as {
    forge: { available: boolean } | null
    capabilities: { followups: boolean; singleProject: boolean; automations: boolean }
  }
  forgeAvailable = health.forge?.available === true
  followupsAvailable = health.capabilities.followups
  automationsAvailable = health.capabilities.automations
  singleProject = health.capabilities.singleProject

  // `ui-state.json` too: the collapse assertion below reads it to prove nothing was written
  // there, and a developer's scratch home must not come out of this run holding a seeded map.
  restoreHome = snapshotSharedHome('config.json', 'ui-state.json')
  seedDir = mkdtempSync(join(tmpdir(), 'cezar-e2e-groups-'))

  // The boot entry as the registry already has it when it is registered — its `lastOpenedAt` is
  // what puts it first in the sidebar's most-recently-opened order, so the seeded siblings get
  // deliberately older ones rather than an empty string apiece.
  const existingBoot = readSharedProjects().find((project) => project.id === bootProject)
  const bootEntry =
    existingBoot ?? {
      id: bootProject,
      root: repoRoot,
      name: bootProject,
      addedAt: '2026-07-20T00:00:00Z',
      lastOpenedAt: '2026-07-20T12:00:00Z',
      source: 'local',
    }
  const alphaEntry = {
    ...ALPHA,
    root: makeRepo('alpha'),
    lastOpenedAt: '2026-07-19T12:00:00Z',
    source: 'local' as const,
  }
  writeSharedProjects(
    singleProject
      ? [bootEntry, alphaEntry]
      : [
          bootEntry,
          alphaEntry,
          { ...BETA, root: makeRepo('beta'), lastOpenedAt: '2026-07-18T12:00:00Z', source: 'local' },
        ],
  )

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  browser?.close()
  restoreHome?.()
  if (seedDir) rmSync(seedDir, { recursive: true, force: true })
})

/** Load the cockpit and wait for the registry query to have produced the seeded groups. Waits on
 *  the three ids rather than on a count, so a slow render and a wrong registry fail differently:
 *  this settles, and the assertions below say what the sidebar actually holds. */
function gotoGrouped(path: string): void {
  browser.goto(baseUrl + path)
  browser.waitForFunction(
    [bootProject, ALPHA.id, BETA.id]
      // `!== null`, not a bare querySelector: the CLI serializes whatever the expression
      // evaluates to, and handing it an Element back is a CDP error, not a wait.
      .map((id) => `document.querySelector('[data-slot="project-task-group"][data-project-id="${id}"]') !== null`)
      .join(' && ')
  )
}

const group = (projectId: string) => `[data-slot="project-task-group"][data-project-id="${projectId}"]`
const groupChevron = (projectId: string) => `${group(projectId)} button[aria-expanded]`

/**
 * Toggle a group to `expanded` and wait until it really is.
 *
 * A bare `click` + wait-for-body is a LAYOUT race, not a handler-wiring one. `browser.click`
 * resolves the element's centre coordinate and then dispatches a mouse event there; meanwhile the
 * boot group is expanded by default and its body is still filling as `useProjectRuns` resolves,
 * which pushes the groups below it down between those two steps. The click lands where the header
 * used to be. That is a harness artifact — React attaches its delegated listener to the root
 * container before any child exists, so a rendered header cannot miss a click for want of a
 * handler, and no real user is losing clicks here.
 *
 * Re-reading `aria-expanded` each attempt is what makes the retry safe: a click that DID register
 * is observed before the next one is sent, so a slow toggle is never double-fired. The helper is
 * also idempotent — call it on an already-open group and it returns without touching anything, so
 * a test never has to assume which state a previous test left behind.
 */
function setGroupExpanded(projectId: string, expanded: boolean): void {
  const header = groupChevron(projectId)
  const state = `document.querySelector('${header}')?.getAttribute('aria-expanded')`
  browser.waitForFunction(`${state} !== null && ${state} !== undefined`)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (browser.evaluate(state) === String(expanded)) break
    browser.click(header)
    try {
      browser.waitForFunction(`${state} === '${expanded}'`)
      break
    } catch {
      // Click landed before the handler did. Fall through and try again.
    }
  }
  browser.waitForFunction(`${state} === '${expanded}'`)
}

describe('the grouped multi-project sidebar', () => {
  it('lists one tree group per registered project, active first, active-only expanded', ({ skip }) => {
    if (singleProject) skip()
    gotoGrouped(scoped(bootProject, '/'))

    // The flat shell is genuinely gone: no single quick-list, and the bar carries the identity
    // the old repo chip used to (name only — asserted by the smoke spec).
    expect(browser.count('[data-slot="quick-list"]')).toBe(0)

    // Most-recently-opened after the active one — the boot project leads because it is active.
    expect(
      browser.evaluate(`Array.from(document.querySelectorAll('[data-slot="project-task-group"]')).map(
        (el) => el.dataset.projectId
      )`)
    ).toEqual([bootProject, ALPHA.id, BETA.id])
    // Every seeded root probed ok — a wrong root renders the inert disabled row.
    expect(browser.count('[data-slot="project-row"][aria-disabled]')).toBe(0)

    // Only ACTIVE projects start expanded (user decision): the one you are looking at, plus any
    // with live work — these fixtures have none, so exactly the boot group is open.
    expect(browser.evaluate(`Array.from(document.querySelectorAll('[data-slot="project-task-group"]')).map(
      (el) => el.querySelector('button[aria-expanded]').getAttribute('aria-expanded')
    )`)).toEqual(['true', 'false', 'false'])

    browser.screenshot(`${artifactsDir}/sidebar-project-groups.png`)
  })

  it('a group row is the door to its project, where the band scopes to it', ({ skip }) => {
    if (singleProject) skip()
    gotoGrouped(scoped(bootProject, '/git'))

    // The active project's band claims exactly one tab for the open URL.
    browser.waitForFunction(`document.querySelector('[data-slot="project-tabs"]') !== null`)
    expect(
      browser.evaluate(`Array.from(document.querySelectorAll('[data-slot="project-tabs"] a[aria-current="page"]'))
        .map((a) => new URL(a.href).pathname)`)
    ).toEqual([scoped(bootProject, '/git')])

    // Clicking another project's row lands in THAT project, and the band re-scopes to it —
    // the per-group nav rows died with the grouped sidebar (user decision: the tree holds
    // tasks; the views ride the band).
    browser.click(`${group(ALPHA.id)} [data-slot="project-row"]`)
    browser.waitForFunction(`location.pathname === '${scoped(ALPHA.id, '/')}'`)
    browser.waitForFunction(`document.querySelector('[data-slot="project-tabs"] a[href="${scoped(ALPHA.id, '/git')}"]') !== null`)
    expect(
      browser.evaluate(
        `Array.from(document.querySelectorAll('[data-slot="project-tabs"] a')).map((a) => new URL(a.href).pathname)`
      )
    ).toEqual(expectedBandHrefs(ALPHA.id))

    // …and each row's + starts a task in its own project.
    expect(
      browser.evaluate(`new URL(document.querySelector('${group(BETA.id)} [data-slot="group-new-task"]').href).pathname`)
    ).toBe(scoped(BETA.id, '/new'))
  })

  it('a collapse is session state: the active-project default wins again on reload', async ({
    skip,
  }) => {
    if (singleProject) skip()
    // Whatever the shared home already holds under the legacy key, verbatim — the assertion at
    // the end is that these toggles left it exactly there.
    const workspaceSidebar = JSON.stringify((await workspaceUiState()).sidebar ?? null)
    gotoGrouped(scoped(bootProject, '/'))

    // Shut the active group; the tree obeys the gesture immediately.
    setGroupExpanded(bootProject, false)

    // Nothing is stored (user decision: expansion follows the active/live rule, not a saved
    // map) — a reload re-opens the active project by that rule.
    expect(browser.evaluate(`localStorage.getItem('cez-sidebar-collapsed')`)).toBe(null)
    gotoGrouped(scoped(bootProject, '/'))
    browser.waitForFunction(
      `document.querySelector('${groupChevron(bootProject)}').getAttribute('aria-expanded') === 'true'`
    )

    // …and neither toggle reached the shared workspace file.
    expect(JSON.stringify((await workspaceUiState()).sidebar ?? null)).toBe(workspaceSidebar)
  })
})

describe('the constrained single-project workspace', () => {
  it('keeps flat navigation and removes every multi-project affordance', ({ skip }) => {
    if (!singleProject) skip()

    browser.goto(baseUrl + scoped(bootProject, '/'))
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
    // Health resolves after the shell's first paint; wait for the capability-driven repaint.
    browser.waitForFunction(`document.querySelector('[data-slot="projects-section"]') === null`)

    // The scratch registry still holds the two sibling rows seeded in beforeAll. The process
    // capability, rather than destructive fixture trimming, must collapse every UI consumer:
    // the whole Projects section (tree, add-local, clone) stays out.
    expect(readSharedProjects().map((project) => project.id)).toEqual([bootProject, ALPHA.id])
    expect(browser.count('[data-slot="project-task-group"]')).toBe(0)
    expect(browser.count('[data-slot="add-project-local"]')).toBe(0)
    expect(browser.count('[data-slot="add-project-clone"]')).toBe(0)

    browser.goto(`${baseUrl}/settings/global`)
    browser.waitForFunction(`document.querySelector('[data-slot="settings-nav"]') !== null`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="settings-nav"] [data-section="projects"]') === null`,
    )
    expect(browser.count('[data-slot="settings-nav"] [data-section="projects"]')).toBe(0)
    expect(browser.count('[data-slot="settings-index"] [data-section="projects"]')).toBe(0)

    browser.goto(`${baseUrl}/settings/global/projects`)
    browser.waitForFunction(`document.querySelector('[data-route="not-found"]') !== null`)
    expect(browser.count('[data-route="settings-global-projects"]')).toBe(0)

    browser.goto(baseUrl + scoped(bootProject, '/new'))
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    expect(browser.count('[data-slot="project-pill"]')).toBe(0)

    browser.screenshot(`${artifactsDir}/sidebar-single-project-constrained.png`)
  })
})
