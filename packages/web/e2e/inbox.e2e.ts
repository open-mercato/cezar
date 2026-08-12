import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, readTestEnv } from './agent-browser'

/**
 * The inbox (R6 Step 1.2) end-to-end against the shared dry-run environment.
 *
 * Reachability: the inbox is `todos.json`-driven and the server watches the file — so this
 * suite seeds real entries exactly like smoke.e2e.ts's SSE-badge test does (same data-dir
 * resolution, same save/restore discipline) and asserts real cards render LIVE over the
 * stream, no reload. Dismiss is honestly reachable (DELETE only rewrites todos.json, which
 * this suite restores) and is exercised below. Run is a client-side navigation to a prefilled
 * `/new` (#374 — it no longer POSTs `/api/v1/todos/:id/start` itself, so no run is ever created
 * just by clicking it) but a full new-task submit is its own surface with its own coverage, so
 * the Run flow past the navigation stays unit-pinned in routes/inbox.test.tsx.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-inbox-${process.pid}`

const DESKTOP = { width: 1440, height: 900 }

// Where `src/index.ts` puts the data dir, for the server booted from this worktree.
const dataDir = resolve(import.meta.dirname, '../../../.ai/cezar')
const todosFile = resolve(dataDir, 'todos.json')

const CARD = '[data-slot="todo-card"]'

let browser: AgentBrowser
let baseUrl: string
let previousTodos: string | null = null
let followupsAvailable = false

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  const health = (await fetch(`${baseUrl}/api/v1/health`).then((r) => r.json())) as {
    capabilities: { followups: boolean }
  }
  followupsAvailable = health.capabilities.followups
  previousTodos = existsSync(todosFile) ? readFileSync(todosFile, 'utf8') : null
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(DESKTOP.width, DESKTOP.height)
})

afterAll(() => {
  // Never leave a developer's inbox holding this test's entries.
  if (previousTodos === null) rmSync(todosFile, { force: true })
  else writeFileSync(todosFile, previousTodos, 'utf8')
  browser?.close()
})

function writeTodos(items: Array<Record<string, string>>): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(todosFile, JSON.stringify(items, null, 2), 'utf8')
}

describe('the inbox against the live dry-run server', () => {
  it('the default-off inbox stays reachable and hides entries already on disk', ({ skip }) => {
    skip(followupsAvailable, 'the shared environment explicitly enabled the inbox')
    writeTodos([
      { id: 'e2e-hidden-1', summary: 'This existing follow-up must stay hidden' },
      { id: 'e2e-hidden-2', summary: 'This one must stay hidden too' },
    ])
    browser.goto(`${baseUrl}/inbox`)
    browser.waitForFunction(
      `document.querySelector('[data-route="inbox"] [data-slot="centered-state"]') !== null`,
    )

    expect(browser.text('[data-slot="centered-state"]')).toContain('The follow-up inbox is off')
    expect(browser.text('[data-route="inbox"] header')).toContain(
      'Disabled for this server; per-task Notes still run.',
    )
    expect(browser.text('[data-route="inbox"] header')).not.toContain(
      'Follow-ups agents suggested',
    )
    expect(browser.count(CARD)).toBe(0)
  })

  it('an enabled empty inbox renders the shared CenteredState template', ({ skip }) => {
    skip(
      !followupsAvailable,
      'the inbox is opt-in; run CEZ_FOLLOWUPS=1 npm run test:e2e -- --force',
    )
    writeTodos([])
    browser.goto(`${baseUrl}/inbox`)
    browser.waitForFunction(
      `document.querySelector('[data-route="inbox"] [data-slot="centered-state"]') !== null`,
    )

    expect(browser.text('[data-slot="centered-state"]')).toContain('Inbox empty')
    expect(browser.count(CARD)).toBe(0)
  })

  it('real cards render LIVE from a server-side todos.json write — no reload', ({ skip }) => {
    skip(
      !followupsAvailable,
      'the inbox is opt-in; run CEZ_FOLLOWUPS=1 npm run test:e2e -- --force',
    )
    // An agent files two follow-ups while the page just sits there on /inbox.
    writeTodos([
      {
        id: 'e2e-inbox-1',
        ts: new Date().toISOString(),
        summary: 'Open a follow-up PR for the flaky retry test',
        action: 'follow-up',
        suggestedSkill: 'om-fix',
        taskId: 'e2e-no-such-run',
      },
      { id: 'e2e-inbox-2', summary: 'Rerun the failed checks' },
    ])

    // No goto: file watch → SSE → todos query → cards. Debounced ~300ms server-side.
    browser.waitForFunction(`document.querySelectorAll('${CARD}').length === 2`)

    expect(browser.text(`${CARD}[data-id="e2e-inbox-1"]`)).toContain(
      'Open a follow-up PR for the flaky retry test',
    )
    // The attention dot: the "needs you" rung of the shared grammar, amber.
    expect(
      browser.count(`${CARD} [data-slot="status-dot"][data-tone="pending"]`),
    ).toBe(2)
    // The meta row is honest about a source task the server no longer has.
    expect(browser.text(`${CARD}[data-id="e2e-inbox-1"]`)).toContain('source task deleted')
    expect(browser.text(`${CARD}[data-id="e2e-inbox-1"]`)).toContain('skill: om-fix')
    // The primary action follows actionability (spec 007): e2e-inbox-1 carries a skill, so it
    // is runnable and keeps Run + Dismiss; e2e-inbox-2 has nothing to execute, so it is a note
    // and offers Acknowledge alone.
    expect(browser.count(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-run"]`)).toBe(1)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-dismiss"]`)).toBe(1)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-acknowledge"]`)).toBe(0)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"] [data-action="todo-acknowledge"]`)).toBe(1)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"] [data-action="todo-run"]`)).toBe(0)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"] [data-action="todo-dismiss"]`)).toBe(0)

    browser.screenshot(`${artifactsDir}/inbox-cards.png`)
  })

  it('Dismiss checks the entry off — card gone, server inbox down to one', async ({ skip }) => {
    skip(
      !followupsAvailable,
      'the inbox is opt-in; run CEZ_FOLLOWUPS=1 npm run test:e2e -- --force',
    )
    browser.click(`${CARD}[data-id="e2e-inbox-1"] [data-action="todo-dismiss"]`)

    browser.waitForFunction(`document.querySelectorAll('${CARD}').length === 1`)
    expect(browser.count(`${CARD}[data-id="e2e-inbox-2"]`)).toBe(1)

    // The server agreed: the DELETE landed in todos.json, not just in the query cache.
    const res = await fetch(`${baseUrl}/api/v1/todos`)
    const items = (await res.json()) as Array<{ id: string }>
    expect(items.map((item) => item.id)).toEqual(['e2e-inbox-2'])
  })
})
