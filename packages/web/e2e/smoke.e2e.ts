import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * R1 smoke test — the real app, a real Chrome, through the agent-browser provider.
 *
 * Scope stays deliberately small: prove the shell the server serves is the right one, is wired
 * to the right routes, and actually lays out. Feature coverage belongs to the steps that add
 * features; this file must stay fast and boring so a checkpoint failure always means something real.
 *
 * Since Step 2.3 the `/` route renders the real app shell (sidebar + single scrolling main),
 * so the assertions below are about that shell rather than the old placeholder.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const runId = `e2e-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }
const IPHONE = { width: 390, height: 844 } // iPhone 14/15 CSS pixels

let browser: AgentBrowser
let baseUrl: string

let forgeAvailable = false
let followupsAvailable = false
let automationsAvailable = false
let bootProject: string

/** A flat route target under the shared env's project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  browser = AgentBrowser.open(runId)
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json())) as {
    forge: { available: boolean } | null
    capabilities: { followups: boolean; automations: boolean }
  }
  forgeAvailable = health.forge?.available === true
  followupsAvailable = health.capabilities.followups
  automationsAvailable = health.capabilities.automations
  bootProject = await bootProjectId(baseUrl)
})

/** The nav the shell renders — GitHub, Inbox and Automations all gate on live health
 *  capabilities, so the expectation must too. Automations carries BOTH gates (#801): it needs a
 *  forge to poll AND the operator's opt-in to exist at all. */
function expectedNavLabels(): string[] {
  return [
    'Tasks',
    ...(followupsAvailable ? ['Inbox'] : []),
    'Git',
    ...(forgeAvailable ? ['GitHub'] : []),
    ...(forgeAvailable && automationsAvailable ? ['Automations'] : []),
    'Skills',
    'Workflows',
    'Settings',
  ]
}

afterAll(() => {
  browser?.close()
})

/** Flip the theme the way the pre-paint script does, then let React pick it up on reload.
 *  Driving the storage key (rather than the toggle button) keeps this independent of where the
 *  toggle currently sits in the chrome. The toggle itself is covered by the unit tests. */
function setTheme(theme: 'light' | 'dark'): void {
  browser.evaluate(`localStorage.setItem('cez-theme', ${JSON.stringify(theme)})`)
  browser.goto(baseUrl + scoped('/'))
}

describe('cockpit app shell', () => {
  beforeAll(() => {
    browser.setViewport(DESKTOP.width, DESKTOP.height)
  })

  it('serves the React cockpit at /', () => {
    browser.goto(baseUrl + scoped('/'))

    // React actually mounted — an empty #root would mean the bundle failed to execute,
    // which is the failure a "200 OK" curl check would happily miss.
    expect(browser.evaluate('document.getElementById("root")?.childElementCount ?? 0')).toBeGreaterThan(0)

    // The token-driven background reaches the DOM: compare the shell's computed color against
    // the value `--background` resolves to, rather than a hardcoded rgb() — this stays true
    // when the palette changes, and fails if the token pipeline breaks.
    const [applied, token] = browser.evaluate(`(() => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--background)'
      document.body.appendChild(probe)
      const token = getComputedStyle(probe).backgroundColor
      probe.remove()
      const shell = getComputedStyle(document.querySelector('[data-slot="app-shell"]')).backgroundColor
      return [shell, token]
    })()`) as [string, string]
    expect(token).toMatch(/^rgb/)
    expect(applied).toBe(token)

    // The legacy shell must not be what we just loaded.
    expect(browser.evaluate('document.getElementById("brand") === null')).toBe(true)
  })

  it('renders the sidebar brand and the whole nav', () => {
    browser.goto(baseUrl + scoped('/'))

    expect(browser.isVisible('[data-slot="sidebar"]')).toBe(true)
    expect(browser.isVisible('[data-slot="brand-tile"]')).toBe(true)
    expect(browser.text('[data-slot="sidebar"] nav')).toContain('Tasks')

    // The GitHub item waits on the health answer — settle it before sampling the nav.
    if (forgeAvailable) {
      browser.waitForFunction(`document.querySelector('[data-slot="sidebar"] nav a[href="${scoped('/github')}"]') !== null`)
    }
    // Read the label without the inbox badge — a populated shared env legitimately has todos,
    // and the badge digit must not leak into the nav-label assertion.
    const labels = browser.evaluate(
      `Array.from(document.querySelectorAll('[data-slot="sidebar"] nav a')).map(a => {
        const clone = a.cloneNode(true)
        clone.querySelector('[data-slot="nav-badge"]')?.remove()
        return clone.textContent.trim()
      })`
    )
    expect(labels).toEqual(expectedNavLabels())

    // The "New task" CTA and its browser-usable accelerator hint. The desktop shell also
    // registers ⌘N, but browsers reserve that chord for opening a window.
    expect(browser.text(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)).toContain('New task')
    expect(browser.text(`[data-slot="sidebar"] a[href="${scoped('/new')}"] kbd`)).toBe('C')

    // The theme toggle lives in the footer.
    expect(browser.isVisible('[data-slot="sidebar-footer"] [data-slot="theme-toggle"]')).toBe(true)

    // …on the footer's SECOND row, beside the gear — never stranded on a third line of its own
    // (#702). Only a real layout engine can answer this: jsdom measures nothing, so the unit
    // suite can pin the structure but not the geometry the 264px column actually produces.
    const footerRows = browser.evaluate(`(() => {
      const footer = document.querySelector('[data-slot="sidebar-footer"]')
      // Centers, not tops: the gear (28px) and the toggle (30px) are different heights, and
      // 'items-center' aligns them by center — comparing tops would fail a correct layout.
      const centerOf = (el) => {
        const rect = el.getBoundingClientRect()
        return rect.top + rect.height / 2
      }
      const center = (sel) => centerOf(footer.querySelector(sel))
      const controls = [
        '[data-slot="command-palette-hint"]',
        '[data-slot="tools-menu-trigger"]',
        '[data-slot="version-chip"]',
        '[data-slot="global-settings-link"]',
        '[data-slot="theme-toggle"]',
      ]
      return {
        search: center('[data-slot="command-palette-hint"]'),
        gear: center('[data-slot="global-settings-link"]'),
        theme: center('[data-slot="theme-toggle"]'),
        rowCount: new Set(
          [...footer.querySelectorAll(controls.join(','))].map((el) => Math.round(centerOf(el)))
        ).size,
      }
    })()`) as { search: number; gear: number; theme: number; rowCount: number }

    // Row 1 is the search bar; row 2 carries the gear and the toggle on one shared centerline.
    expect(footerRows.search).toBeLessThan(footerRows.gear)
    expect(Math.abs(footerRows.theme - footerRows.gear)).toBeLessThanOrEqual(1)
    // Exactly two rows — every other footer control shares the controls row's centerline.
    expect(footerRows.rowCount).toBe(2)
  })

  it('keeps the footer controls inside the 264px column even on a nightly-length version', () => {
    browser.goto(baseUrl + scoped('/'))
    browser.waitForFunction(`document.querySelector('[data-slot="version-chip"]') !== null`)

    // The e2e server reports this checkout's own (short) semver, which never overflowed. The
    // string that DID is the nightly dist-tag of #876 — so write it into the chip and measure
    // what the real layout engine does with it. Every control in the row but the chip is
    // `shrink-0`, so before the chip could give, this pushed the gear and the theme toggle
    // bodily outside the sidebar's right edge instead of clipping anything.
    const overflow = browser.evaluate(`(() => {
      const chip = document.querySelector('[data-slot="version-chip"]')
      const label = chip.querySelector('span:not([data-slot])')
      label.textContent = 'v0.9.2-nightly.20260813.1'
      const sidebarRight = document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().right
      const escaped = [...document.querySelectorAll('[data-slot="sidebar-footer-controls"] > *')]
        .filter((el) => el.getBoundingClientRect().right > sidebarRight)
        .map((el) => el.dataset.slot)
      return { escaped, truncated: label.scrollWidth > Math.ceil(label.getBoundingClientRect().width) }
    })()`) as { escaped: string[]; truncated: boolean }

    expect(overflow.escaped).toEqual([])
    // …and the chip absorbed it by clipping its own label, which is where the `title` earns its keep.
    expect(overflow.truncated).toBe(true)
  })

  it('fills the repo and version chips from the live /api/v1/health', async () => {
    // The server runs against this checkout (a real git repo), so health is real data — the one
    // thing a jsdom test with a mocked fetch cannot prove. Ask it from here rather than inside
    // the page: `eval` hands back whatever the expression evaluates to, and a promise is not a
    // value — an `await` in there would assert against `{}` and pass on nothing.
    const health = (await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json())) as {
      version: string
      repoRoot: string
      repo: { branch: string } | null
    }
    expect(health.repo).not.toBeNull()

    browser.goto(baseUrl + scoped('/'))
    // The chips are async — they appear only once the health query answers.
    browser.waitForFunction(`document.querySelector('[data-slot="repo-chip"]') !== null`)

    // Compared against what the server says right now, not a hardcoded repo name: this asserts
    // the client → query → chip path really carries live API data, and stays true wherever the
    // suite runs (any checkout, any branch).
    const repoName = health.repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    expect(browser.text('[data-slot="repo-chip"]')).toBe(`${repoName} / ${health.repo?.branch}`)
    expect(browser.text('[data-slot="version-chip"]')).toBe(`v${health.version}`)

    // Real values, not a placeholder that happens to match itself.
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(repoName).toBeTruthy()

    browser.screenshot(`${artifactsDir}/shell-repo-chip.png`)
  })

  it('marks exactly one nav item active, following the route', () => {
    const activeLabel = () =>
      browser.evaluate(
        `Array.from(document.querySelectorAll('[data-slot="sidebar"] nav a[aria-current="page"]')).map(a => a.textContent.trim())`
      )

    // Every URL below is a LEGACY flat one, so each load settles in two hops: the boot-project
    // redirect, then whatever the route itself redirects to. Sampling the nav before the last
    // hop reads the wrong screen's answer, so wait for the settled pathname each time.
    const settleAt = (pathname: string) =>
      browser.waitForFunction(`location.pathname === '${pathname}'`)

    browser.goto(baseUrl + '/')
    settleAt(scoped('/'))
    expect(activeLabel()).toEqual(['Tasks'])

    browser.goto(baseUrl + '/git')
    settleAt(scoped('/git'))
    expect(activeLabel()).toEqual(['Git'])

    // The nested Settings area: the more specific item wins, and only it. `/settings/skills`
    // is itself a redirect onto the top-level catalog, so this asserts both hops.
    browser.goto(baseUrl + '/settings/skills')
    settleAt(scoped('/skills'))
    expect(activeLabel()).toEqual(['Skills'])
  })

  it('makes main the only scroller — the document never scrolls', () => {
    browser.goto(baseUrl + scoped('/'))

    const layout = browser.evaluate(`(() => {
      const shell = document.querySelector('[data-slot="app-shell"]')
      const main = document.querySelector('[data-slot="main"]')
      return {
        shellHeight: shell.getBoundingClientRect().height,
        viewport: window.innerHeight,
        bodyOverflow: getComputedStyle(document.body).overflowY,
        mainOverflow: getComputedStyle(main).overflowY,
        mainOverscroll: getComputedStyle(main).overscrollBehaviorY,
        sidebarWidth: document.querySelector('[data-slot="sidebar"]').getBoundingClientRect().width,
      }
    })()`) as Record<string, unknown>

    // The shell is exactly one viewport tall — this is what `h-dvh` has to produce.
    expect(layout.shellHeight).toBe(layout.viewport)
    expect(layout.bodyOverflow).toBe('hidden')
    expect(layout.mainOverflow).toBe('auto')
    expect(layout.mainOverscroll).toBe('contain')
    expect(layout.sidebarWidth).toBe(264)
  })

  it('screenshots the shell in both themes', () => {
    setTheme('dark')
    expect(browser.evaluate('document.documentElement.classList.contains("light")')).toBe(false)
    browser.screenshot(`${artifactsDir}/shell-dark.png`)

    setTheme('light')
    expect(browser.evaluate('document.documentElement.classList.contains("light")')).toBe(true)
    // The palette really flipped: light `--background` is white, dark is near-black.
    expect(
      browser.evaluate(`getComputedStyle(document.querySelector('[data-slot="app-shell"]')).backgroundColor`)
    ).toBe('rgb(255, 255, 255)')
    browser.screenshot(`${artifactsDir}/shell-light.png`)

    setTheme('dark')
  })
})

describe('mobile shell', () => {
  beforeAll(() => {
    browser.setViewport(IPHONE.width, IPHONE.height)
  })

  afterAll(() => {
    browser.setViewport(DESKTOP.width, DESKTOP.height)
  })

  it('hides the sidebar and shows the top bar at an iPhone viewport', () => {
    browser.goto(baseUrl + scoped('/'))

    expect(browser.isVisible('[data-slot="sidebar"]')).toBe(false)
    expect(browser.isVisible('[data-slot="mobile-top-bar"]')).toBe(true)
    expect(browser.text('[data-slot="mobile-top-bar"]')).toContain('Tasks')

    const bar = browser.evaluate(`(() => {
      const menu = document.querySelector('[data-slot="mobile-top-bar"] button')
      const rect = menu.getBoundingClientRect()
      return { width: rect.width, height: rect.height, label: menu.getAttribute('aria-label') }
    })()`) as { width: number; height: number; label: string }

    // Touch targets ≥44px (spec's mobile rules).
    expect(bar.label).toBe('Open menu')
    expect(bar.width).toBeGreaterThanOrEqual(44)
    expect(bar.height).toBeGreaterThanOrEqual(44)

    browser.screenshot(`${artifactsDir}/shell-iphone.png`)
  })

  it('never overflows the viewport horizontally', () => {
    browser.goto(baseUrl + scoped('/'))

    // A 264px sidebar that failed to hide, or a nav row wider than the phone, shows up here
    // first — as a page that scrolls sideways. `<=`, not `===`: the document may legitimately
    // be narrower than the viewport, it just must never be wider.
    const overflow = browser.evaluate(
      `[document.documentElement.scrollWidth, window.innerWidth]`
    ) as [number, number]
    expect(overflow[0]).toBeLessThanOrEqual(overflow[1])
  })

  describe('nav drawer', () => {
    const DRAWER = '[data-slot="mobile-nav-drawer"]'
    const MENU_BUTTON = '[data-slot="mobile-top-bar"] button[aria-label="Open menu"]'

    // The drawer slides in over 500ms and out over 300ms, so every assertion has to wait for the
    // transition to settle. "Settled open" is specifically `left === 0`: mid-flight it is already
    // mounted and already `visible`, just parked off-screen at left: -264.
    const SETTLED_OPEN = `(() => {
      const d = document.querySelector('${DRAWER}')
      return !!d && d.getBoundingClientRect().left === 0
    })()`
    const GONE = `document.querySelector('${DRAWER}') === null`

    function openDrawer(): void {
      browser.click(MENU_BUTTON)
      browser.waitForFunction(SETTLED_OPEN)
    }

    it('opens over a backdrop, and covers the viewport top to bottom', () => {
      browser.goto(baseUrl + scoped('/'))
      // Closed means unmounted, not merely hidden — hence count rather than isVisible.
      expect(browser.count(DRAWER)).toBe(0)

      openDrawer()
      expect(browser.isVisible(DRAWER)).toBe(true)
      expect(browser.isVisible('[data-slot="sheet-overlay"]')).toBe(true)

      // The drawer nav mirrors the desktop one, including the forge-gated GitHub item — settle
      // the health answer before sampling the labels.
      if (forgeAvailable) {
        browser.waitForFunction(`document.querySelector('${DRAWER} nav a[href="${scoped('/github')}"]') !== null`)
      }

      const box = browser.evaluate(`(() => {
        const rect = document.querySelector('${DRAWER}').getBoundingClientRect()
        const links = Array.from(document.querySelectorAll('${DRAWER} nav a'))
        const overlay = document.querySelector('[data-slot="sheet-overlay"]').getBoundingClientRect()
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          overlayWidth: overlay.width,
          overlayHeight: overlay.height,
          minLinkHeight: Math.min(...links.map((a) => a.getBoundingClientRect().height)),
          labels: links.map((a) => {
            const clone = a.cloneNode(true)
            clone.querySelector('[data-slot="nav-badge"]')?.remove()
            return clone.textContent.trim()
          }),
        }
      })()`) as Record<string, number | string[]>

      // Anchored to the left edge, full height, and the sidebar's own width.
      expect(box.left).toBe(0)
      expect(box.top).toBe(0)
      expect(box.width).toBe(264)
      expect(box.height).toBe(box.viewportHeight)

      // The backdrop really is a backdrop: it dims the whole viewport, not just the gap.
      expect(box.overlayWidth).toBe(box.viewportWidth)
      expect(box.overlayHeight).toBe(box.viewportHeight)

      // The same nav the desktop sidebar renders — at touch size, not the 34px desktop row.
      expect(box.labels).toEqual(expectedNavLabels())
      expect(box.minLinkHeight).toBeGreaterThanOrEqual(44)

      browser.screenshot(`${artifactsDir}/drawer-iphone.png`)
    })

    it('navigates and closes when a nav item is tapped', () => {
      browser.goto(baseUrl + scoped('/'))
      openDrawer()

      browser.click(`${DRAWER} nav a[href="${scoped('/git')}"]`)
      browser.waitForFunction(GONE)

      // Both halves: it routed, *and* the drawer is not still sitting on top of the new view.
      expect(browser.url()).toBe(baseUrl + scoped('/git'))
      expect(browser.count(DRAWER)).toBe(0)
      expect(browser.text('[data-slot="mobile-top-bar"]')).toContain('Git')
    })

    it('closes when the backdrop is tapped, without navigating', () => {
      browser.goto(baseUrl + scoped('/'))
      openDrawer()

      // Beside the 264px drawer, in the dimmed strip on the right. By coordinate because the
      // overlay's own center point sits *under* the drawer, where a tap means something else.
      browser.tapAt(IPHONE.width - 40, Math.round(IPHONE.height / 2))
      browser.waitForFunction(GONE)

      expect(browser.count(DRAWER)).toBe(0)
      expect(browser.url()).toBe(baseUrl + scoped('/'))
    })

    it('closes on Escape', () => {
      browser.goto(baseUrl + scoped('/'))
      openDrawer()

      browser.press('Escape')
      browser.waitForFunction(GONE)
      expect(browser.count(DRAWER)).toBe(0)
    })

    it('is unreachable on a desktop viewport', () => {
      browser.setViewport(DESKTOP.width, DESKTOP.height)
      try {
        browser.goto(baseUrl + scoped('/'))
        // The trigger is `md:hidden`, so there is no way in — and the real sidebar is the nav.
        expect(browser.isVisible('[data-slot="mobile-top-bar"]')).toBe(false)
        expect(browser.count(DRAWER)).toBe(0)
        expect(browser.isVisible('[data-slot="sidebar"]')).toBe(true)
      } finally {
        browser.setViewport(IPHONE.width, IPHONE.height)
      }
    })

    it('does not overflow the viewport while open', () => {
      browser.goto(baseUrl + scoped('/'))
      openDrawer()

      // The drawer is `fixed` and 264px of a 390px viewport, but a stray `w-3/4`/`sm:max-w-sm`
      // interaction or a too-wide nav row would push the document sideways.
      const overflow = browser.evaluate(
        `[document.documentElement.scrollWidth, window.innerWidth]`
      ) as [number, number]
      expect(overflow[0]).toBeLessThanOrEqual(overflow[1])
    })
  })
})

/**
 * The global SSE stream, end to end: a real `/api/v1/events`, a real EventSource, a real reducer.
 *
 * The interesting half is not that a socket opens — it is that a server-side change reaches the
 * rendered UI with nobody reloading anything. The inbox is the one path this suite can drive for
 * free: `.ai/cezar/todos.json` is a documented external contract (agents append to it via
 * `CEZ_TODOS_FILE`), the server watches the file and re-broadcasts the whole array on `todos`, and
 * the nav badge renders whatever the todos query holds. So writing that file *is* a live event —
 * no fixture invented, nothing mocked.
 *
 * The `run` path is deliberately not asserted here: proving a live run's `run` events land would
 * need a run that actually executes, and CEZ_DRY_RUN's mock agent is not a fixture this step has.
 * The jsdom tests cover those reducers against the exact payloads the server sends.
 */
describe('global SSE stream', () => {
  // Where `src/index.ts` puts the data dir, for the server booted from this worktree.
  const dataDir = resolve(import.meta.dirname, '../../../.ai/cezar')
  const todosFile = resolve(dataDir, 'todos.json')
  const BADGE = '[data-slot="nav-badge"]'
  let previousTodos: string | null = null

  beforeAll(() => {
    browser.setViewport(DESKTOP.width, DESKTOP.height)
    previousTodos = existsSync(todosFile) ? readFileSync(todosFile, 'utf8') : null
  })

  afterAll(() => {
    // Never leave a developer's inbox holding this test's entries.
    if (previousTodos === null) rmSync(todosFile, { force: true })
    else writeFileSync(todosFile, previousTodos, 'utf8')
  })

  function writeTodos(items: Array<Record<string, string>>): void {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(todosFile, JSON.stringify(items, null, 2), 'utf8')
  }

  it('holds an open stream the server accepts', () => {
    browser.goto(baseUrl + scoped('/'))

    // A second stream, opened from the page, against the same endpoint the app uses: it proves
    // `/api/v1/events` really speaks SSE to this origin (readyState 1 = OPEN) and keeps the socket up
    // rather than answering and closing. That the *app's* own stream is open is what the badge test
    // below proves — an EventSource is not reachable from outside the bundle, and a test-only
    // handle hung off `window` to reach it would be scaffolding, not evidence.
    browser.evaluate(`window.__cezProbe = new EventSource('/api/v1/events'), true`)
    browser.waitForFunction(`window.__cezProbe.readyState === 1`)
    expect(browser.evaluate('window.__cezProbe.readyState')).toBe(1)
    browser.evaluate(`window.__cezProbe.close(), delete window.__cezProbe, true`)
  })

  it('live-updates the inbox badge from a server-side change, with no reload', ({ skip }) => {
    skip(
      !followupsAvailable,
      'the shared environment has the opt-in inbox disabled; run CEZ_FOLLOWUPS=1 npm run test:e2e -- --force',
    )
    writeTodos([])
    browser.goto(baseUrl + scoped('/'))
    // The shell is up and its queries have answered — so the app's stream effect has run too.
    browser.waitForFunction(`document.querySelector('[data-slot="repo-chip"]') !== null`)
    expect(browser.count(BADGE)).toBe(0)

    // An agent files two follow-ups while the page just sits there.
    writeTodos([
      { id: 'e2e-1', summary: 'Review the PR' },
      { id: 'e2e-2', summary: 'Rerun the checks' },
    ])

    // No goto: if this ever passes, it passed because file watch → SSE → reducer → badge worked.
    // (Debounced ~300ms server-side, so this waits rather than samples.)
    browser.waitForFunction(`document.querySelector('${BADGE}')?.textContent === '2'`)
    expect(browser.text(BADGE)).toBe('2')

    browser.screenshot(`${artifactsDir}/inbox-badge-live.png`)

    // And the reverse: the payload is the whole inbox, so emptying it empties the badge.
    writeTodos([])
    browser.waitForFunction(`document.querySelector('${BADGE}') === null`)
    expect(browser.count(BADGE)).toBe(0)

    // The stream outliving several seconds of this is the "stays alive" assertion: the shell is
    // still the shell, not a blank root left by a handler that threw.
    expect(browser.isVisible('[data-slot="sidebar"]')).toBe(true)
    expect(browser.text('[data-slot="sidebar"] nav')).toContain('Inbox')
  })
})

describe('legacy cockpit retirement (R7)', () => {
  it('the React shell New task CTA stays in the SPA — the React composer, not legacy (R4 1.1)', () => {
    browser.goto(baseUrl + scoped('/'))
    browser.click(`[data-slot="sidebar"] a[href="${scoped('/new')}"]`)
    // Client-side navigation: the React /new hero renders and no legacy markup ever loads.
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)

    expect(browser.url()).toBe(baseUrl + scoped('/new'))
    expect(browser.evaluate('document.getElementById("brand") === null')).toBe(true)
    expect(browser.evaluate('document.getElementById("root") !== null')).toBe(true)
  })

  it('/?legacy=1 serves the React shell — the escape hatch retired with the page (R7 1.1)', () => {
    browser.goto(baseUrl + '/?legacy=1')

    // #brand was legacy-only markup from the deleted web/index.html — it exists
    // in no React template, so its absence proves the old page cannot come back.
    expect(browser.evaluate('document.getElementById("root") !== null')).toBe(true)
    expect(browser.evaluate('document.getElementById("brand") === null')).toBe(true)
    browser.waitForFunction(`document.querySelector('[data-slot="sidebar"]') !== null`)
  })

  it('serves the React shell for a full load of /new — the R1 legacy pin is gone (R4 1.3)', () => {
    // The React composer now carries the bookmarklet contract (/new?skill=&ref=&auto=1&key=),
    // so a full document load of /new gets the shell like every other route. Without a valid
    // key nothing starts — this link only prefills (the full auto-start matrix runs against
    // the dry-run server in new-task.e2e.ts).
    browser.goto(baseUrl + '/new?skill=om-code-review&ref=hello&auto=1')

    expect(browser.evaluate('document.getElementById("root") !== null')).toBe(true)
    expect(browser.evaluate('document.getElementById("brand") === null')).toBe(true)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
    // The sensitive params are stripped from the address bar (legacy replaceState parity).
    browser.waitForFunction(`location.search === ''`)
    // The legacy flat `/new?…` bookmarklet grammar still lands, now on its scoped twin.
    expect(browser.url()).toBe(baseUrl + scoped('/new'))
  })

  it('/new?legacy=1 serves the React shell too — no route treats the query specially', () => {
    browser.goto(baseUrl + '/new?legacy=1')

    expect(browser.evaluate('document.getElementById("root") !== null')).toBe(true)
    expect(browser.evaluate('document.getElementById("brand") === null')).toBe(true)
    browser.waitForFunction(`document.querySelector('[data-route="new"]') !== null`)
  })
})
