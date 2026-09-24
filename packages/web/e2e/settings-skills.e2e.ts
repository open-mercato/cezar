import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * Settings → Skills (R6 Step 1.4) end-to-end against the shared dry-run environment.
 *
 * Reachability: fully reachable. The server discovers skills fresh on every GET, so the
 * suite seeds two real project skills into this worktree's `.ai/skills/` (removed in
 * afterAll) — the catalog renders them bold and first (#377) next to whatever global skills
 * the host machine genuinely has. Refresh hits the real POST (no team repos configured in
 * dry-run → a fast no-op fetch answering the same catalog), which is exactly the #384
 * scenario: a refetch must not lose selection. Nothing else mutates state.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-settings-skills-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

const skillsDir = resolve(import.meta.dirname, '../../../.ai/skills')
const ALPHA = 'e2e-alpha-skill'
const BETA = 'e2e-beta-skill'

let browser: AgentBrowser
let baseUrl: string
let createdSkillsDir = false
let bootProject: string

/** A flat route target under this server's own project prefix (multi-project spec, step 3.2):
 *  every cockpit link is scoped, and every legacy flat URL redirects onto its scoped twin. */
const scoped = (path: string) => `/p/${bootProject}${path}`

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  bootProject = await bootProjectId(baseUrl)
  createdSkillsDir = !existsSync(skillsDir)
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    resolve(skillsDir, `${ALPHA}.md`),
    `---\nname: ${ALPHA}\ndescription: An e2e-seeded project skill\n---\n\n# Alpha skill\n\nDo the alpha thing.\n`,
    'utf8',
  )
  writeFileSync(
    resolve(skillsDir, `${BETA}.md`),
    `---\nname: ${BETA}\ndescription: The second seeded skill\n---\n\nDo the beta thing.\n`,
    'utf8',
  )
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave test skills in a developer's catalog.
  rmSync(resolve(skillsDir, `${ALPHA}.md`), { force: true })
  rmSync(resolve(skillsDir, `${BETA}.md`), { force: true })
  if (createdSkillsDir) rmSync(skillsDir, { recursive: true, force: true })
  browser?.close()
})

const row = (name: string) => `[data-slot="skill-row"][data-skill="${name}"]`

describe('settings → skills against the live dry-run server', () => {
  it('the catalog renders the seeded project skills bold-first, and a click opens the markdown detail', () => {
    browser.goto(`${baseUrl}${scoped('/settings/skills')}`)
    browser.waitForFunction(`document.querySelector('${row(ALPHA)}') !== null`)

    // Seeded repo skills are project skills — tagged, emphasized, and ahead of every
    // global/team skill in the list (#377).
    expect(browser.count(`${row(ALPHA)}[data-project="true"]`)).toBe(1)
    expect(browser.count(`${row(BETA)}[data-project="true"]`)).toBe(1)
    const ordered = browser.evaluate(
      `(() => {
        const rows = [...document.querySelectorAll('[data-slot="skill-row"]')]
        const firstGlobal = rows.findIndex((r) => !r.hasAttribute('data-project'))
        const lastProject = rows.map((r) => r.hasAttribute('data-project')).lastIndexOf(true)
        return firstGlobal === -1 || lastProject < firstGlobal
      })()`,
    )
    expect(ordered).toBe(true)

    browser.click(row(ALPHA))
    browser.waitForFunction(
      `document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"] h2')?.textContent === '${ALPHA}'`,
    )
    // The body rendered as MARKDOWN: the seeded `# Alpha skill` became a real heading.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="skill-body"] h1')].some((h) => h.textContent === 'Alpha skill')`,
    )
    expect(browser.text('[data-slot="skill-body"]')).toContain('Do the alpha thing.')
    browser.screenshot(`${artifactsDir}/settings-skills.png`)
  })

  it('refresh keeps the selection and the list scroll position (#384)', () => {
    browser.click(row(BETA))
    browser.waitForFunction(
      `document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"] h2')?.textContent === '${BETA}'`,
    )

    // The host's real global catalog makes the list overflow — pin a scroll offset on it.
    // The read-back must be 150: if the container did not truly overflow the browser would
    // clamp to 0 and the whole scroll assertion would be vacuous.
    browser.evaluate(`document.querySelector('[data-slot="skill-rows"]').scrollTop = 150`)
    const before = Number(browser.evaluate(`document.querySelector('[data-slot="skill-rows"]').scrollTop`))
    expect(before).toBe(150)

    browser.click('[data-slot="skills-refresh"]')
    // The button disables while the POST runs; wait until the round-trip settled.
    browser.waitForFunction(`!document.querySelector('[data-slot="skills-refresh"]').disabled`)
    browser.waitForFunction(`document.querySelector('[data-slot="toaster"]')?.textContent.includes('refreshed')`)

    // Selection and scroll both survived the refetch.
    expect(browser.count(`${row(BETA)}[aria-current="page"]`)).toBe(1)
    expect(
      browser.evaluate(
        `document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"] h2').textContent`,
      ),
    ).toBe(BETA)
    expect(Number(browser.evaluate(`document.querySelector('[data-slot="skill-rows"]').scrollTop`))).toBe(
      before,
    )
  })

  it('the pinned bookmarklet panel generates javascript: launchers against /new', () => {
    // The pinned row sits at the bottom of the (viewport-tall) list column, which a long
    // skill detail can push past the fold — scroll it in before the click, as a user would.
    browser.evaluate(
      `document.querySelector('[data-slot="bookmarklets-row"]').scrollIntoView({ block: 'center' })`,
    )
    browser.click('[data-slot="bookmarklets-row"]')
    browser.waitForFunction(`document.querySelector('[data-slot="bookmarklet-panel"]') !== null`)
    // The imperative href lands after mount — wait for the real javascript: URL.
    browser.waitForFunction(
      `(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')?.getAttribute('href') ?? '').startsWith('javascript:')`,
    )

    const generic = String(
      browser.evaluate(`document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]').getAttribute('href')`),
    )
    // The protected /new deep-link grammar, baked with the server's real launch key — now
    // under this project's own URL prefix (multi-project spec, step 3.6).
    expect(decodeURIComponent(generic)).toContain(`${scoped('/new')}?'+q`)
    expect(decodeURIComponent(generic)).toMatch(/auto=0&key=[^&]+&ref=/)

    // One launcher per catalog skill, the seeded ones included.
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')].some((a) => a.textContent.includes('/${ALPHA}'))`,
    )
    browser.screenshot(`${artifactsDir}/settings-skills-bookmarklets.png`)
  })
})
