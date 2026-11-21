import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv, stopFixtureServer } from './agent-browser'

/**
 * The composer's model picker against a Claude CLI that ANSWERS `list_models` and one that
 * refuses it (#869, follow-up to #841/#784), plus the cross-runner guard.
 *
 * The bundled dry-run `mock-claude.mjs` answers `list_models` with a fixed catalog
 * (sonnet / opus / opus[1m]) unless `CEZ_MOCK_CLAUDE_NO_LIST_MODELS=1`, so one spec reaches both
 * halves by booting its own server twice over the same fixture repo. Codex is pointed at
 * `fixtures/codex-gpt-models.mjs`, because the dry-run Codex mock lists no `gpt-*` id.
 *
 * Reachability: fully — no forge, no agent login. Everything lives in a throwaway repo and
 * `HOME`, removed in afterAll; the shared test env is never touched.
 *
 * Not reachable here: the OpenCode half of the gateway-id guard. The dry-run OpenCode catalog
 * lists `mock/mock-model` only, and a runner switch clears the pick, so `anthropic/claude-…`
 * can only ride in through the host's native settings — `new-task-form.test.ts` owns that.
 */

const sessionId = `e2e-model-picker-${process.pid}`
const codexFixture = resolve(import.meta.dirname, 'fixtures/codex-gpt-models.mjs')
const DATED_PRESETS = ['Fable 5', 'Opus 4.8', 'Sonnet 5', 'Haiku 4.5']
const UNAVAILABLE = 'Latest Claude models unavailable'

let browser: AgentBrowser
let server: ChildProcess | undefined
let dataRoot: string
let baseUrl: string
let bootProject: string

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
      // Still starting.
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: the model-picker server never answered at ${url}`)
}

/** (Re)boot the fixture server; the port stays put so a reload lands on the same origin (and
 *  therefore the same localStorage) as before the restart. */
async function boot(extra: Record<string, string>, port: number): Promise<void> {
  baseUrl = `http://localhost:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot, {
      // No native agent settings: a host `~/.claude/settings.json` naming a model would add a
      // "custom" row to the picker and make every exact-list assertion machine-dependent.
      HOME: join(dataRoot, '.home'),
      CEZ_CODEX_BIN: codexFixture,
      ...extra,
    }),
    stdio: 'ignore',
  })
  await waitForHealth(baseUrl)
  bootProject = await bootProjectId(baseUrl)
}

async function stop(): Promise<void> {
  const child = server
  server = undefined
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill()
    await exited
  }
}

const gotoComposer = () => {
  browser.goto(`${baseUrl}/p/${bootProject}/new`)
  browser.waitForFunction(`document.querySelector('[data-slot="model-pill"]') !== null`)
}

const MENU = `[data-testid="model-pill-menu"]`
const labelsJs = `[...document.querySelectorAll('${MENU} [role="menuitemradio"]')].map((el) => el.querySelector('.font-medium')?.textContent?.trim())`

function openModelMenu(): void {
  browser.click('[data-slot="model-pill"]')
  browser.waitForFunction(`document.querySelector('${MENU}') !== null`)
}

function closeMenu(): void {
  browser.press('Escape')
  browser.waitForFunction(`document.querySelector('[role="menu"]') === null`)
}

function menuLabels(): string[] {
  return browser.evaluate(labelsJs) as string[]
}

/** Discovery is async: wait for the menu to hold `count` rows before reading it. */
function waitForRows(count: number): void {
  browser.waitForFunction(`(${labelsJs}).length === ${count}`)
}

function menuStatus(): { text: string; disabled: boolean } | null {
  return browser.evaluate(
    `(() => { const el = document.querySelector('${MENU} [role="menuitem"]'); return el ? { text: el.textContent.trim(), disabled: el.hasAttribute('data-disabled') } : null })()`,
  ) as { text: string; disabled: boolean } | null
}

function pickModel(label: string): void {
  browser.evaluate(
    `[...document.querySelectorAll('${MENU} [role="menuitemradio"]')].find((el) => el.querySelector('.font-medium')?.textContent?.trim() === ${JSON.stringify(label)}).click()`,
  )
  browser.waitForFunction(`document.querySelector('${MENU}') === null`)
}

function pickRunner(runner: string): void {
  browser.click('[data-slot="runner-pill"]')
  browser.waitForFunction(`document.querySelector('[data-testid="runner-pill-menu"]') !== null`)
  browser.evaluate(
    `[...document.querySelectorAll('[data-testid="runner-pill-menu"] [role="menuitemradio"]')].find((el) => el.querySelector('.font-medium')?.textContent?.trim() === ${JSON.stringify(runner)}).click()`,
  )
  browser.waitForFunction(`document.querySelector('[data-testid="runner-pill-menu"]') === null`)
  browser.waitForFunction(`document.querySelector('[data-slot="runner-pill"]')?.textContent.includes(${JSON.stringify(runner)})`)
}

const pillText = () => browser.text('[data-slot="model-pill"]')

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-model-picker-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# model picker fixture\n', 'utf8')
  mkdirSync(join(dataRoot, '.home'), { recursive: true })
  git('add', 'README.md')
  git('commit', '-qm', 'init')

  const port = await freePort()
  await boot({}, port)
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 60_000)

afterAll(async () => {
  browser?.close()
  await stop()
  await stopFixtureServer(undefined, dataRoot)
})

describe('model picker: discovery, fallback and the cross-runner guard', () => {
  it('discovery: auto plus exactly the CLI catalog, no status row, no dated preset', () => {
    gotoComposer()
    expect(browser.text('[data-slot="runner-pill"]')).toContain('claude')
    openModelMenu()
    waitForRows(4)
    expect(menuLabels()).toEqual(['auto', 'Mock Sonnet', 'Mock Opus', 'Mock Opus (1M context)'])
    expect(menuStatus()).toBeNull()
    const text = String(browser.evaluate(`document.querySelector('${MENU}').textContent`))
    for (const dated of DATED_PRESETS) expect(text).not.toContain(dated)

    pickModel('Mock Opus (1M context)')
    expect(pillText()).toContain('Mock Opus (1M context)')
  })

  it('cross-runner: a bare gpt-* id picked on codex does not follow the pick back to claude', () => {
    gotoComposer()
    pickRunner('codex')
    openModelMenu()
    waitForRows(2)
    expect(menuLabels()).toEqual(['auto', 'gpt-5.1'])
    pickModel('gpt-5.1')
    expect(pillText()).toContain('gpt-5.1')

    pickRunner('claude')
    expect(pillText()).not.toContain('gpt-5.1')
    openModelMenu()
    waitForRows(4)
    expect(menuLabels()).not.toContain('gpt-5.1')
    closeMenu()

    // The remembered draft must not resurrect it either.
    gotoComposer()
    expect(browser.text('[data-slot="runner-pill"]')).toContain('claude')
    expect(pillText()).not.toContain('gpt-5.1')
  })

  it('gateway ids stay selectable on pi', () => {
    gotoComposer()
    pickRunner('pi')
    openModelMenu()
    const labels = menuLabels()
    expect(labels).toContain('claude-sonnet-5')
    expect(labels).toContain('gpt-5.1')
    pickModel('claude-sonnet-5')
    expect(pillText()).toContain('claude-sonnet-5')
    // Back on claude the gateway pick is gone: it is pi's, not a claude model.
    pickRunner('claude')
    expect(pillText()).not.toContain('claude-sonnet-5')
  })

  it('fallback: a CLI that refuses list_models leaves the tier aliases and the status row', async () => {
    await stop()
    await boot({ CEZ_MOCK_CLAUDE_NO_LIST_MODELS: '1' }, Number(new URL(baseUrl).port))
    gotoComposer()
    openModelMenu()
    waitForRows(5)
    expect(menuLabels()).toEqual(['auto', 'fable', 'opus', 'sonnet', 'haiku'])
    browser.waitForFunction(`document.querySelector('${MENU} [role="menuitem"]') !== null`)
    expect(menuStatus()).toEqual({ text: UNAVAILABLE, disabled: true })
    const text = String(browser.evaluate(`document.querySelector('${MENU}').textContent`))
    for (const dated of DATED_PRESETS) expect(text).not.toContain(dated)
    closeMenu()
  })
})
