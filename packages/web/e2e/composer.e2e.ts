import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, cezarCli, fixtureServeEnv } from './agent-browser'

/**
 * The composer (R3 Step 2.1) end-to-end, against a LIVE dry-run session — not a replayed
 * fixture: a real `cezar` (CEZ_DRY_RUN=1) on a real tmp git repo runs a real task through the
 * mock claude, whose reply carries no CEZ:DONE marker, so the run parks at `waiting` — the
 * exact state the composer exists for. What this spec proves is the full loop: type a reply
 * (with a `/` skill completion from this repo's own `.ai/skills`), send, and watch the
 * transcript grow over SSE because the server accepted and persisted the message.
 *
 * Dictation: Chrome ships `webkitSpeechRecognition` natively, but driving the REAL recognizer
 * would need mic hardware + Google's speech backend — not honest in CI. Instead the page's
 * global is replaced with a scriptable stand-in BEFORE the mic is pressed (the adapter reads
 * the global at press time, by design), so the real overlay renders and is screenshotted with
 * a real partial transcript flowing through the real component.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-composer-${process.pid}`

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
  throw new Error(`cezar e2e: the composer server never answered at ${url}`)
}

async function waitForStatus(url: string, id: string, wanted: string[]): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = (await (await fetch(`${url}/api/v1/runs/${id}`)).json()) as { status: string }
    if (wanted.includes(record.status)) return record.status
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`cezar e2e: run ${id} never reached status "${wanted.join('/')}"`)
}

let browser: AgentBrowser
let server: ChildProcess
let dataRoot: string
let baseUrl: string
let runId: string

beforeAll(async () => {
  // A REAL git repo — the engine creates a worktree for the run, which needs a commit.
  dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-composer-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# composer e2e fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  // One PROJECT skill — the `/` menu must list it first and bold, ahead of any skill the
  // machine happens to have globally (~/.claude/skills etc., which we cannot control here).
  mkdirSync(join(dataRoot, '.ai/skills'), { recursive: true })
  writeFileSync(
    join(dataRoot, '.ai/skills/lint-fix.md'),
    '---\ndescription: Fix lint findings in the changed files\n---\n\nRun the linter and fix everything it reports.\n',
    'utf8',
  )

  const port = await freePort()
  baseUrl = `http://localhost:${port}`
  server = spawn(
    process.execPath,
    [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'],
    { env: fixtureServeEnv(dataRoot), stdio: 'ignore' },
  )
  await waitForHealth(baseUrl)

  // Boot the run the composer will talk to. The mock's reply has no CEZ:DONE marker, so after
  // its first turn the session stays open and the run parks at `waiting`.
  const created = (await (
    await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Say hello to the composer e2e.', workflow: 'quick-task' }),
    })
  ).json()) as { id: string }
  runId = created.id
  await waitForStatus(baseUrl, runId, ['waiting'])

  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
  browser.goto(`${baseUrl}/tasks/${runId}`)
  browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea') !== null`)
}, 180_000)

afterAll(() => {
  browser?.close()
  server?.kill()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
})

describe('the thread composer against a live waiting session', () => {
  it('waiting state: paused hint pulses above an enabled composer with the reply placeholder', () => {
    expect(browser.text('[data-slot="paused-hint"]')).toContain(
      'The agent is paused, waiting for your reply',
    )
    const composer = browser.evaluate(`(() => {
      const textarea = document.querySelector('[data-slot="composer"] textarea')
      return { disabled: textarea.disabled, placeholder: textarea.placeholder }
    })()`) as { disabled: boolean; placeholder: string }
    expect(composer.disabled).toBe(false)
    expect(composer.placeholder).toBe('Reply — / for skills, @ for files…')
    // Chrome has the Web Speech API — the labeled mic must be there, left of send.
    expect(browser.isVisible('[aria-label="Start dictation"]')).toBe(true)
    browser.screenshot(`${artifactsDir}/composer-idle.png`)
  })

  it('typing /lin opens the skills menu with the project skill first and emphasized (#380)', () => {
    browser.click('[data-slot="composer"] textarea')
    browser.fill('[data-slot="composer"] textarea', 'Please run /lin')
    browser.waitForFunction(
      `document.querySelector('[data-slot="composer-menu"] [data-slot="composer-menu-item"]') !== null`,
    )
    const first = browser.evaluate(`(() => {
      const el = document.querySelector('[data-slot="composer-menu-item"]')
      return { text: el.textContent, emphasized: el.dataset.emphasized ?? null }
    })()`) as { text: string; emphasized: string | null }
    expect(first.text).toContain('lint-fix')
    expect(first.text).toContain('Fix lint findings')
    expect(first.emphasized).toBe('true')
    browser.screenshot(`${artifactsDir}/composer-autocomplete.png`)
  })

  it('Enter inserts /lint-fix at the caret and closes the menu', () => {
    // `press` targets the focused element — make sure that is still the textarea.
    browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').focus() ?? true`)
    browser.press('Enter')
    browser.waitForFunction(
      `document.querySelector('[data-slot="composer"] textarea').value === 'Please run /lint-fix '`,
    )
    // The popover animates out — wait for the unmount rather than sampling mid-exit.
    browser.waitForFunction(`document.querySelector('[data-slot="composer-menu"]') === null`)
  })

  it('send delivers the reply — the transcript grows with the new user bubble over SSE', () => {
    const bubblesBefore = browser.count('[data-slot="user-bubble"]')
    browser.click('[aria-label="Send"]')
    // The optimistic clear is immediate…
    browser.waitForFunction(`document.querySelector('[data-slot="composer"] textarea').value === ''`)
    // …and the proof the server ACCEPTED it: the persisted user-message comes back on the
    // run's own event stream and lands in the thread.
    browser.waitForFunction(
      `document.querySelectorAll('[data-slot="user-bubble"]').length === ${bubblesBefore + 1}`,
    )
    expect(
      browser.evaluate(`[...document.querySelectorAll('[data-slot="user-bubble"]')].at(-1).textContent`),
    ).toBe('Please run /lint-fix')
  })

  it('the mock answers the reply and the run parks at waiting again', async () => {
    await waitForStatus(baseUrl, runId, ['waiting'])
    // The agent's answer to our message rendered — the round trip is complete.
    browser.waitForFunction(`document.querySelector('[data-slot="paused-hint"]') !== null`)
  }, 90_000)

  it('dictation: recording swaps the footer for the overlay — timer, partial transcript', () => {
    // Replace the page's Web Speech global with a scriptable stand-in (see the header note).
    browser.evaluate(`(() => {
      class FakeRecognition {
        start() { window.__cezRecognition = this }
        stop() {} abort() {}
      }
      window.SpeechRecognition = FakeRecognition
      window.webkitSpeechRecognition = FakeRecognition
      return true
    })()`)
    browser.click('[aria-label="Start dictation"]')
    browser.waitForFunction(`document.querySelector('[data-slot="dictation-overlay"]') !== null`)
    expect(browser.text('[data-slot="dictation-timer"]')).toMatch(/^\d+:\d{2}$/)
    expect(browser.text('[data-slot="dictation-transcript"]')).toContain('Listening…')

    // A partial result flows through the real component.
    browser.evaluate(`window.__cezRecognition.onresult({
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript: 'summarize what you did' } }],
    }) ?? true`)
    browser.waitForFunction(
      `document.querySelector('[data-slot="dictation-transcript"]').textContent === 'summarize what you did'`,
    )
    browser.screenshot(`${artifactsDir}/composer-dictation.png`)
  })

  it('insert puts the transcript into the textarea and restores the footer', () => {
    browser.evaluate(`window.__cezRecognition.onresult({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: 'summarize what you did' } }],
    }) ?? true`)
    browser.click('[aria-label="Insert transcription"]')
    browser.waitForFunction(
      `document.querySelector('[data-slot="composer"] textarea').value === 'summarize what you did'`,
    )
    expect(browser.count('[data-slot="dictation-overlay"]')).toBe(0)
    expect(browser.isVisible('[aria-label="Send"]')).toBe(true)
    // Leave the draft box clean for the closed-state spec below.
    browser.fill('[data-slot="composer"] textarea', '')
  })

  it('a closed session keeps the composer authorable — sending it is Continue', async () => {
    // Finish the waiting session. When the mock's turns touched notes.md the run parks at
    // `review` first (the documented double-finish path) — accept that and finish again.
    await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
    if ((await waitForStatus(baseUrl, runId, ['done', 'review'])) === 'review') {
      await fetch(`${baseUrl}/api/v1/runs/${runId}/finish`, { method: 'POST' })
      await waitForStatus(baseUrl, runId, ['done'])
    }

    browser.goto(`${baseUrl}/tasks/${runId}`)
    // The run has a session to resume, so the composer stays live: the draft becomes the
    // prompt the reopened session starts on, and its send button IS Continue.
    browser.waitForFunction(
      `document.querySelector('[data-slot="composer"] textarea')?.disabled === false`,
    )
    expect(
      browser.evaluate(`document.querySelector('[data-slot="composer"] textarea').placeholder`),
    ).toBe('Continue — add a prompt, or send to just reopen the session…')
    // Nothing typed still continues — the legacy one-click behavior.
    expect(browser.isVisible('[aria-label="Continue"]')).toBe(true)
    expect(
      browser.evaluate(`document.querySelector('[aria-label="Continue"]').disabled`),
    ).toBe(false)
    // The engine pills moved into the live footer with it.
    expect(browser.count('[data-slot="follow-up-engine"]')).toBe(1)
    expect(browser.count('[data-slot="paused-hint"]')).toBe(0)
    browser.screenshot(`${artifactsDir}/composer-closed.png`)

    // …and typing a prompt then sending reopens the session on it.
    browser.fill('[data-slot="composer"] textarea', 'one more thing: add a note')
    browser.click('[aria-label="Continue"]')
    await waitForStatus(baseUrl, runId, ['running', 'waiting'])
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="user-bubble"]')].some((b) =>
        b.textContent.includes('one more thing: add a note'))`,
    )
  }, 60_000)
})
