import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AgentBrowser, bootProjectId, readTestEnv } from './agent-browser'

/**
 * Task tags end to end (spec 2026-11-23-task-tags § 10): create a task with a new tag, filter the
 * project list by it, rename the tag in Settings, and see the new name on the task.
 */

const artifactsDir = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
const sessionId = `e2e-task-tags-${process.pid}`
const tagName = `e2e batch ${process.pid}`
const renamed = `e2e renamed ${process.pid}`

let browser: AgentBrowser
let baseUrl: string
let tagId: string | undefined
let runId: string
let project: string

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

beforeAll(async () => {
  baseUrl = readTestEnv().baseUrl
  mkdirSync(artifactsDir, { recursive: true })
  project = await bootProjectId(baseUrl)
  const run = await json<{ id: string; tags?: Array<{ id: string; name: string }> }>('/runs', {
    method: 'POST',
    body: JSON.stringify({ task: 'A tagged task.', workflow: 'quick-task', tags: [{ name: tagName }] }),
  })
  runId = run.id
  tagId = run.tags?.[0]?.id
  browser = AgentBrowser.open(sessionId)
  browser.setViewport(1440, 900)
}, 120_000)

afterAll(async () => {
  if (tagId) await fetch(`${baseUrl}/api/v1/workspace/task-tags/${tagId}`, { method: 'DELETE' }).catch(() => {})
  browser?.close()
})

describe('task tags against the live dry-run server', () => {
  it('a task created with a new tag shows it, and the list filters by it', () => {
    expect(tagId).toMatch(/^tt-/)
    browser.goto(`${baseUrl}/p/${project}/tasks`)
    browser.waitForFunction(`document.querySelector('[data-route="tasks"] [data-slot="facet-task-tag"]') !== null`)
    browser.click('[data-slot="facet-task-tag"]')
    // cmdk owns `data-value` (it becomes the label), so the option is found by its text.
    const option = `[...document.querySelectorAll('[data-slot="facet-option"]')].find((el) => el.textContent.startsWith(${JSON.stringify(tagName)}))`
    browser.waitForFunction(`${option} !== undefined`)
    browser.evaluate(`${option}.click()`)
    browser.press('Escape')
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="task-tag-chip"]')].some((el) => el.textContent.includes(${JSON.stringify(tagName)}))`,
    )
    browser.screenshot(resolve(artifactsDir, 'task-tags-filtered.png'))
    expect(browser.text('[data-route="tasks"]')).toContain('A tagged task.')
  })

  it('renaming the tag in Settings renames it on the task', () => {
    browser.goto(`${baseUrl}/settings/global/task-tags`)
    const input = `input[aria-label=${JSON.stringify(`Name of ${tagName}`)}]`
    browser.waitForFunction(`document.querySelector(${JSON.stringify(input)}) !== null`)
    browser.fill(input, renamed)
    browser.press('Enter')
    // The row's label follows the registry, so it changes once the rename has landed.
    const after = `input[aria-label=${JSON.stringify(`Name of ${renamed}`)}]`
    browser.waitForFunction(`document.querySelector(${JSON.stringify(after)}) !== null`)
    browser.screenshot(resolve(artifactsDir, 'task-tags-settings.png'))
    browser.goto(`${baseUrl}/tasks/${runId}`)
    browser.waitForFunction(
      `[...document.querySelectorAll('[data-slot="run-tags"] [data-slot="task-tag-chip"]')].some((el) => el.textContent.includes(${JSON.stringify(renamed)}))`,
    )
    browser.screenshot(resolve(artifactsDir, 'task-tags-header.png'))
  })
})
