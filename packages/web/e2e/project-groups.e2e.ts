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
function expectedNavHrefs(projectId: string): string[] {
  return [
    scoped(projectId, '/'),
    ...(followupsAvailable ? [scoped(projectId, '/inbox')] : []),
    scoped(projectId, '/git'),
    ...(forgeAvailable ? [scoped(projectId, '/github')] : []),
    // #801: the automations opt-in is workspace-wide, the forge gate is per project — the item
    // needs both.
    ...(forgeAvailable && automationsAvailable ? [scoped(projectId, '/automations')] : []),
    scoped(projectId, '/skills'),
    scoped(projectId, '/workflows'),
    scoped(projectId, '/settings'),
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
  return (await (await fetch(`${baseUrl}/api/v1/workspace/ui-state`)).json()) as {
    sidebar?: { collapsed?: Record<string, boolean> }
  }
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
      .map((id) => `document.querySelector('[data-slot="project-group"][data-project="${id}"]') !== null`)
      .join(' && ')
  )
}

const groupHeader = (projectId: string) =>
  `[data-slot="project-group"][data-project="${projectId}"] [data-slot="project-group-header"]`
const groupBody = (projectId: string) =>
  `[data-slot="project-group"][data-project="${projectId}"] [data-slot="project-group-body"]`

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
  const header = groupHeader(projectId)
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
  browser.waitForFunction(
    `document.querySelector('${groupBody(projectId)}') ${expanded ? '!==' : '==='} null`
  )
}

describe('the grouped multi-project sidebar', () => {
  it('replaces the flat nav with one group per registered project', ({ skip }) => {
    if (singleProject) skip()
    gotoGrouped(scoped(bootProject, '/'))

    expect(browser.isVisible('[data-slot="project-groups"]')).toBe(true)
    // The flat shell is genuinely gone, not merely covered: its nav and its single quick-list
    // are the two surfaces `AppShell` swaps out for the group list.
    expect(browser.count('[data-slot="sidebar"] nav[aria-label="Main"]')).toBe(0)
    expect(browser.count('[data-slot="task-quick-list"]')).toBe(0)
    // …and so is the repo chip, which the first group's header now says instead.
    expect(browser.count('[data-slot="repo-chip"]')).toBe(0)

    // Most-recently-opened first, and every seeded root probed `ok` — a wrong root would render
    // the inert "folder not found" row and this would read `missing`.
    expect(
      browser.evaluate(`Array.from(document.querySelectorAll('[data-slot="project-group"]')).map(
        (el) => [el.dataset.project, el.dataset.status]
      )`)
    ).toEqual([
      [bootProject, 'ok'],
      [ALPHA.id, 'ok'],
      [BETA.id, 'ok'],
    ])

    // The project you are looking at is open, the rest are shut (the no-stored-state default).
    expect(browser.evaluate(`Array.from(document.querySelectorAll('[data-slot="project-group-header"]'))
      .map((el) => el.getAttribute('aria-expanded'))`)).toEqual(['true', 'false', 'false'])
    expect(browser.count('[data-slot="project-group-body"]')).toBe(1)

    browser.screenshot(`${artifactsDir}/sidebar-project-groups.png`)
  })

  it('scopes every group nav to its own project, and lights only the active one', ({ skip }) => {
    if (singleProject) skip()
    gotoGrouped(scoped(bootProject, '/git'))
    setGroupExpanded(ALPHA.id, true)
    // The GitHub row waits on the health answer — settle it before sampling any group's nav,
    // exactly as the flat-shell specs do.
    if (forgeAvailable) {
      browser.waitForFunction(
        `document.querySelector('${groupBody(ALPHA.id)} a[href="${scoped(ALPHA.id, '/github')}"]') !== null`
      )
    }

    const hrefs = (projectId: string) =>
      browser.evaluate(
        `Array.from(document.querySelectorAll('${groupBody(projectId)} nav a')).map((a) => new URL(a.href).pathname)`
      )

    // The whole point of a group: it links into a project that is NOT the active one.
    expect(hrefs(bootProject)).toEqual(expectedNavHrefs(bootProject))
    expect(hrefs(ALPHA.id)).toEqual(expectedNavHrefs(ALPHA.id))

    // `/git` is a flat, project-agnostic route, so exactly one Git row may claim the URL — the
    // one in the scoped group. Alpha's Git link points elsewhere and must stay unmarked.
    expect(
      browser.evaluate(`Array.from(document.querySelectorAll('[data-slot="project-groups"] a[aria-current="page"]'))
        .map((a) => new URL(a.href).pathname)`)
    ).toEqual([scoped(bootProject, '/git')])

    // Each group's door into its own tasks pane.
    expect(
      browser.evaluate(
        `new URL(document.querySelector('${groupBody(ALPHA.id)} [data-slot="project-group-more"]').href).pathname`
      )
    ).toBe(scoped(ALPHA.id, '/'))
  })

  it('persists a collapse in THIS browser, so a reload keeps it and the workspace file does not', async ({
    skip,
  }) => {
    if (singleProject) skip()
    // Whatever the shared home already holds under the legacy key, verbatim — the assertion at
    // the end is that these toggles left it exactly there.
    const workspaceSidebar = JSON.stringify((await workspaceUiState()).sidebar ?? null)
    gotoGrouped(scoped(bootProject, '/'))

    // Shut the active group — the one case the default would re-open on its own, so a reload
    // that still finds it shut can only mean the state was stored and read back.
    setGroupExpanded(bootProject, false)

    // Stored locally and synchronously: there is no debounced PUT to wait on any more, so the
    // value is already there when the chevron has turned.
    expect(storedCollapse()[bootProject]).toBe(true)

    gotoGrouped(scoped(bootProject, '/'))
    expect(browser.count(groupBody(bootProject))).toBe(0)
    expect(
      browser.evaluate(`document.querySelector('${groupHeader(bootProject)}').getAttribute('aria-expanded')`)
    ).toBe('false')

    // And back: the same gesture re-opens it, so the stored `true` is a toggle and not a trap.
    setGroupExpanded(bootProject, true)
    expect(storedCollapse()[bootProject]).toBe(false)

    // The whole point of the move: a second cockpit — a phone, another window — keeps its own
    // answer, which it cannot do if either toggle reached the shared workspace file.
    expect(JSON.stringify((await workspaceUiState()).sidebar ?? null)).toBe(workspaceSidebar)
  })
})

describe('the constrained single-project workspace', () => {
  it('keeps flat navigation and removes every multi-project affordance', ({ skip }) => {
    if (!singleProject) skip()

    browser.goto(baseUrl + scoped(bootProject, '/'))
    browser.waitForFunction(
      `document.querySelector('[data-slot="sidebar"] nav[aria-label="Main"]') !== null`,
    )
    // Health resolves after the shell's first paint; before that the safe default preserves the
    // ordinary Add-project control. Wait for the capability-driven repaint, not merely the nav.
    browser.waitForFunction(`document.querySelector('button[aria-label="Add project"]') === null`)

    // The scratch registry still holds the two sibling rows seeded in beforeAll. The process
    // capability, rather than destructive fixture trimming, must collapse every UI consumer.
    expect(readSharedProjects().map((project) => project.id)).toEqual([bootProject, ALPHA.id])
    expect(browser.count('[data-slot="project-groups"]')).toBe(0)
    expect(browser.isVisible('[data-slot="sidebar"] nav[aria-label="Main"]')).toBe(true)
    expect(browser.count('button[aria-label="Add project"]')).toBe(0)

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
