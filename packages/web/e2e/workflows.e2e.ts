import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * The workflow builder (R6 Step 1.6) end-to-end against the shared dry-run environment.
 *
 * Reachability: fully reachable. The server discovers skills fresh on every GET, so the suite
 * seeds two real project skills into this worktree's `.ai/skills/` (removed in afterAll) and
 * builds a small workflow from them: palette → canvas adds, the YAML preview, Save (a real
 * file lands in `.ai/cezar/workflows/`, read back and parsed here), keyboard reorder through
 * dnd-kit's defaults, Import through the server's `/api/v1/workflows/parse`, and the 8-step
 * limit. The saved file is removed in afterAll so a developer's repo stays clean.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-workflows-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

const repoRoot = resolve(import.meta.dirname, '../../..')
const skillsDir = resolve(repoRoot, '.ai/skills')
const ALPHA = 'e2e-wb-alpha'
const BETA = 'e2e-wb-beta'
const FLOW = 'e2e-wb-flow'
const savedFlowPath = resolve(repoRoot, `.ai/cezar/workflows/${FLOW}.yaml`)

let browser: AgentBrowser
let baseUrl: string
let createdSkillsDir = false

beforeAll(() => {
  baseUrl = readTestEnv().baseUrl
  // A crashed earlier run may have left the saved flow behind — Save would then 409.
  rmSync(savedFlowPath, { force: true })
  createdSkillsDir = !existsSync(skillsDir)
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(
    resolve(skillsDir, `${ALPHA}.md`),
    `---\nname: ${ALPHA}\ndescription: First e2e-seeded skill\n---\n\nDo the alpha thing.\n`,
    'utf8',
  )
  writeFileSync(
    resolve(skillsDir, `${BETA}.md`),
    `---\nname: ${BETA}\ndescription: Second e2e-seeded skill\n---\n\nDo the beta thing.\n`,
    'utf8',
  )
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave test skills or test workflow files in a developer's repo.
  rmSync(resolve(skillsDir, `${ALPHA}.md`), { force: true })
  rmSync(resolve(skillsDir, `${BETA}.md`), { force: true })
  if (createdSkillsDir) rmSync(skillsDir, { recursive: true, force: true })
  rmSync(savedFlowPath, { force: true })
  browser?.close()
})

const palettePill = (name: string) => `[data-slot="wb-skill"][data-skill="${name}"]`
const addButton = (name: string) => `${palettePill(name)} [data-slot="wb-skill-add"]`
const stepIdsJs = `[...document.querySelectorAll('[data-slot="wb-step"]')].map((s) => s.dataset.id).join(',')`

describe('workflow builder against the live dry-run server', () => {
  it('builds a small workflow from the palette and previews the portable YAML', () => {
    browser.goto(`${baseUrl}/workflows`)
    browser.waitForFunction(`document.querySelector('${palettePill(ALPHA)}') !== null`)

    // Start from a clean canvas: whatever the repo's first saved workflow is, "+ new" resets.
    browser.click('[data-slot="wb-new"]')
    browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 0`)

    browser.click(addButton(ALPHA))
    browser.click(addButton(BETA))
    browser.waitForFunction(`${stepIdsJs} === '${ALPHA},${BETA}'`)
    expect(browser.text('[data-slot="wb-count"]')).toBe('2 skills')

    // The preview speaks the portable compact form for a pure skill stack (spec 012).
    const yaml = browser.text('[data-slot="wb-yaml"]')
    expect(yaml).toContain('skills:')
    expect(yaml).toContain(`- ${ALPHA}`)
    expect(yaml).toContain(`- ${BETA}`)
    expect(yaml).not.toContain('steps:')
    browser.screenshot(`${artifactsDir}/workflows-builder.png`)
  })

  it('reorders steps with the keyboard (dnd-kit defaults: Space lifts, arrows move, Space drops)', () => {
    // Each phase gets an explicit sync point — pressing before the previous phase settled is a
    // race the sensor loses silently (the lift needs focus; the move needs the lift's measuring
    // pass). dnd-kit marks the activator with aria-pressed="true" for the duration of the drag.
    const grip = `document.querySelector('[data-slot="wb-step"][data-id="${ALPHA}"] [data-slot="wb-step-grip"]')`
    browser.evaluate(`${grip}.focus()`)
    browser.waitForFunction(`document.activeElement === ${grip}`)
    browser.press('Space')
    browser.waitForFunction(`${grip}.getAttribute('aria-pressed') === 'true'`)
    // An arrow pressed before the lift's measuring pass settles is swallowed, and dropping
    // before the move settles resolves the collision against stale coordinates — both land the
    // item back where it started. Drive it like a user: press, watch dnd-kit's live region for
    // the settled move-over announcement, retry a swallowed press. Two items — no overshoot.
    const overBeta = () =>
      String(
        browser.evaluate(`[...document.querySelectorAll('[aria-live]')].map((n) => n.textContent).join(' ')`),
      ).includes(`was moved over droppable area ${BETA}`)
    let moved = false
    for (let press = 0; press < 5 && !moved; press++) {
      browser.press('ArrowDown')
      for (let poll = 0; poll < 10 && !moved; poll++) moved = overBeta()
    }
    expect(moved).toBe(true)
    browser.press('Space')
    browser.waitForFunction(`${stepIdsJs} === '${BETA},${ALPHA}'`)
    // Order is execution order — the YAML preview follows the move.
    expect(browser.text('[data-slot="wb-yaml"]').indexOf(BETA)).toBeLessThan(
      browser.text('[data-slot="wb-yaml"]').indexOf(ALPHA),
    )
  })

  it('Save writes a real portable workflow file the server round-trips', () => {
    browser.fill('[data-slot="wb-name"]', FLOW)
    browser.click('[data-slot="wb-save"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="toaster"]')?.textContent.includes('Saved — ${FLOW}.yaml')`,
    )

    // The exported artifact on disk IS the compact portable form.
    const doc = parse(readFileSync(savedFlowPath, 'utf8')) as Record<string, unknown>
    expect(doc).toEqual({ name: FLOW, skills: [BETA, ALPHA] })

    // The catalog refetched: the new chain has a chip, and Delete now exists for it.
    browser.waitForFunction(`document.querySelector('[data-slot="wb-load-chip"][data-name="${FLOW}"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="wb-delete"]') !== null`)
    browser.screenshot(`${artifactsDir}/workflows-saved.png`)
  })

  it('Import parses pasted YAML through the server and renders richer flows as full steps', () => {
    const pasted = [
      `name: ${FLOW}-imported`,
      'steps:',
      '  - id: fix',
      `    skill: ${ALPHA}`,
      "    prompt: '{{task}}'",
      '  - id: tests',
      '    command: npm test',
      '    onFail:',
      '      retry: fix',
      '      max: 2',
    ].join('\n')
    browser.click('[data-slot="wb-import"]')
    browser.waitForFunction(`document.querySelector('[data-slot="wb-import-text"]') !== null`)
    browser.fill('[data-slot="wb-import-text"]', pasted)
    browser.click('[data-slot="wb-import-run"]')

    browser.waitForFunction(`${stepIdsJs} === 'fix,tests'`)
    expect(browser.text('[data-slot="wb-count"]')).toBe('2 steps')
    // The check step wears its badge; the preview switched to the full steps form.
    expect(browser.text('[data-slot="wb-step"][data-id="tests"] [data-slot="wb-step-badge"]')).toBe('check')
    expect(browser.text('[data-slot="wb-yaml"]')).toContain('steps:')
    expect(browser.text('[data-slot="wb-yaml"]')).toContain('command: npm test')
    browser.screenshot(`${artifactsDir}/workflows-imported.png`)
  })

  it('refuses the 9th step with the legacy limit message', () => {
    // 2 imported steps on the canvas — fill up to the server's cap of 8, then one more.
    for (let i = 0; i < 6; i++) browser.click(addButton(ALPHA))
    browser.waitForFunction(`document.querySelectorAll('[data-slot="wb-step"]').length === 8`)

    browser.click(addButton(ALPHA))
    browser.waitForFunction(
      `document.querySelector('[data-slot="toaster"]')?.textContent.includes('at most 8 steps')`,
    )
    expect(browser.count('[data-slot="wb-step"]')).toBe(8)
  })
})
