import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv, stopFixtureServer } from './agent-browser'

/**
 * Quoting a fragment of a message (spec 2026-11-20-quote-message-fragments) against a LIVE dry-run
 * server: select words in an assistant message, Quote, add a note on the chip, send, and jump back
 * from the card — in the task thread and in the manager chat.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-quotes-${process.pid}`
const TASK_COMPOSER = '[data-slot="composer"] textarea'
const NEW_MANAGER_BOX = 'textarea[aria-label="What should this manager do?"]'
const MANAGER_BOX = '[data-route="manager-chat"] textarea'
const MANAGER_IDLE = `document.querySelector('[data-route="manager-chat"] [role="status"][aria-label="Working"]') === null`
const TOOLBAR_BUTTON = '[data-slot="quote-selection-toolbar"] button'
const NOTE = 'Is this still true after the refactor?'

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
  throw new Error(`cezar e2e: the quotes server never answered at ${url}`)
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as { status: string }
    if (wanted.includes(record.status)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached "${wanted.join('/')}"`)
}

async function startRun(url: string, task: string): Promise<string> {
  const created = (await (
    await fetch(`${url}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task, workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  await waitForStatus(url, created.id, ['waiting'])
  return created.id
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let runId: string

/**
 * Selects up to 24 characters of the first non-blank text node inside `bodySelector` with a real
 * DOM Range, the way a mouse drag ends, and returns the selected text.
 */
const selectWords = (bodySelector: string): string =>
  String(browser.evaluate(`(() => {
    const body = document.querySelector(${JSON.stringify(bodySelector)})
    if (!body) throw new Error('no quotable body')
    body.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.textContent.trim().length >= 8 && !node.parentElement.closest('[data-quote-excluded]')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    })
    const node = walker.nextNode()
    if (!node) throw new Error('no text to select')
    const start = node.textContent.search(/\\S/)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, Math.min(node.textContent.length, start + 24))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  })()`))

/** The toolbar is positioned a frame after `selectionchange`; until then it is invisible. */
const quoteSelection = () => {
  browser.waitForFunction(`(() => {
    const bar = document.querySelector('[data-slot="quote-selection-toolbar"]')
    return bar !== null && getComputedStyle(bar).visibility !== 'hidden'
  })()`)
  browser.click(TOOLBAR_BUTTON)
  browser.waitForFunction(`document.querySelector('[data-slot="quote-selection-toolbar"]') === null`)
}

/** Opens the chip's note editor, types the note and saves it with Enter (which must not send). */
const addNote = (chipScope: string) => {
  browser.click(`${chipScope} [data-slot="quote-chip"] button[aria-label^="Edit note on quote"]`)
  browser.waitForFunction(`document.querySelector('input[aria-label="Note on quote"]') !== null`)
  browser.fill('input[aria-label="Note on quote"]', NOTE)
  browser.press('Enter')
  browser.waitForFunction(`document.querySelector('${chipScope} [data-slot="quote-chip"] button[aria-label$="(has a note)"]') !== null`)
}

const clickJump = (scope: string) =>
  browser.evaluate(`(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(`${scope} [data-slot="quote-card"] button`)})]
      .find((el) => /^Jump to message/.test(el.getAttribute('aria-label') ?? el.textContent.trim()))
    if (!button) throw new Error('no Jump to message button')
    button.click()
    return true
  })()`)

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-quotes-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# quotes e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)
  runId = await startRun(baseUrl, 'Explain the retry path.')

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 240_000)

afterAll(async () => {
  browser?.close()
  await stopFixtureServer(server, dataRoot)
})

describe('quote a fragment of a message', () => {
  it('task thread: select, Quote, note on the chip, send, card, jump back', async () => {
    browser.goto(`${baseUrl}/tasks/${runId}`)
    browser.waitForFunction(`document.querySelector('${TASK_COMPOSER}') !== null`)
    // The agent's reply to the task: the most common quote. It has no seq of its own and quotes
    // as ref 0, "the reply to the task".
    const quotable = '[data-slot="assistant-message"] [data-quote-body][data-quote-ref="0"]'
    browser.waitForFunction(`document.querySelector('${quotable}') !== null`)

    const selected = selectWords(quotable)
    expect(selected.trim().length).toBeGreaterThan(0)
    browser.screenshot(`${artifactsDir}/quote-fragments-task-selection.png`, { viewport: true })
    quoteSelection()

    browser.waitForFunction(`document.querySelectorAll('[data-slot="composer"] [data-slot="quote-chip"]').length === 1`)
    expect(browser.text('[data-slot="composer"] [data-slot="quote-chip"]')).toContain(selected.trim().slice(0, 12))
    addNote('[data-slot="composer"]')
    browser.screenshot(`${artifactsDir}/quote-fragments-task-chip.png`, { viewport: true })

    browser.fill(TASK_COMPOSER, 'Please check this.')
    browser.click('[aria-label="Send"]')
    browser.waitForFunction(`document.querySelector('[data-slot="composer"] [data-slot="quote-chip"]') === null`)

    browser.waitForFunction(`document.querySelector('[data-slot="quote-card"]') !== null`)
    const card = browser.text('[data-slot="quote-card"]')
    expect(card).toContain('From the reply to the task')
    expect(card).toContain(selected.trim().slice(0, 12))
    expect(card).toContain(NOTE)
    await waitForStatus(baseUrl, runId, ['waiting'])

    // Away from the source first, so the jump has somewhere to go.
    browser.evaluate(`document.querySelector('[data-slot="quote-card"]').scrollIntoView({ block: 'end' })`)
    clickJump('')
    browser.waitForFunction(`document.querySelector('[data-slot="assistant-message"][data-jump-highlight]')
      ?.closest('[data-row-key]')?.dataset.rowKey.startsWith('turn-fallback-') === true`)
    browser.screenshot(`${artifactsDir}/quote-fragments-task-jump.png`, { viewport: true })
  }, 120_000)

  it('manager chat: select, Quote, note on the chip, send, card, jump back', () => {
    browser.goto(`${baseUrl}/manager`)
    browser.waitForFunction(`document.querySelector('[data-route="manager-new"]') !== null`)
    browser.click('[data-slot="manager-preset"]')
    browser.waitForFunction(`document.querySelector(${JSON.stringify(NEW_MANAGER_BOX)}).value.length > 0`)
    browser.click('button[aria-label="Create manager"]')
    browser.waitForFunction(`document.querySelector('[data-route="manager-chat"]') !== null`)
    browser.waitForFunction(`document.querySelector('[data-slot="manager-assistant"] [data-quote-body]') !== null`)
    browser.waitForFunction(MANAGER_IDLE)

    const source = '[data-slot="manager-assistant"] [data-quote-body]'
    const messageId = String(browser.evaluate(`document.querySelector('${source}').closest('[data-message-id]').dataset.messageId`))
    const selected = selectWords(source)
    expect(selected.trim().length).toBeGreaterThan(0)
    quoteSelection()

    const chips = '[data-route="manager-chat"] [data-slot="quote-chip"]'
    browser.waitForFunction(`document.querySelectorAll('${chips}').length === 1`)
    expect(browser.text(chips)).toContain(selected.trim().slice(0, 12))
    addNote('[data-route="manager-chat"]')
    browser.screenshot(`${artifactsDir}/quote-fragments-manager-chip.png`, { viewport: true })

    browser.fill(MANAGER_BOX, 'Tell me more about this.')
    browser.evaluate(`document.querySelector(${JSON.stringify(MANAGER_BOX)}).focus()`)
    browser.waitForFunction(`document.activeElement === document.querySelector(${JSON.stringify(MANAGER_BOX)})`)
    browser.press('Enter')
    browser.waitForFunction(`document.querySelector('${chips}') === null`)

    browser.waitForFunction(`document.querySelector('[data-slot="manager-user"] [data-slot="quote-card"]') !== null`)
    const card = browser.text('[data-slot="manager-user"] [data-slot="quote-card"]')
    expect(card).toContain('From assistant message')
    expect(card).toContain(selected.trim().slice(0, 12))
    expect(card).toContain(NOTE)
    browser.waitForFunction(MANAGER_IDLE)

    // Scroll away so the jump has somewhere to go, then land on the quoted message.
    browser.evaluate(`document.querySelector('[data-slot="manager-user"] [data-slot="quote-card"]').scrollIntoView({ block: 'end' })`)
    clickJump('[data-slot="manager-user"]')
    browser.waitForFunction(`(() => {
      const target = document.querySelector('[data-message-id="${messageId}"]')
      const rect = target.getBoundingClientRect()
      return rect.bottom > 0 && rect.top < window.innerHeight && target.hasAttribute('data-jump-highlight')
    })()`)
    expect(browser.text('body')).not.toContain('That message is no longer in this transcript')
    browser.screenshot(`${artifactsDir}/quote-fragments-manager-jump.png`, { viewport: true })
  }, 120_000)
})
