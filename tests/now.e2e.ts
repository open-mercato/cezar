import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

import { createMockTask, projectPrefix, stubNoRuns, taskTitle } from './helpers/cockpit'

describe('now', { tags: ['now'] }, () => {
  test('opens with the Now header, the search and the All tasks link', async ({ app, screen, browser }) => {
    await app.open('/')
    await expect(browser).toHaveURL(/\/p\/[^/]+\/$/)
    await expect(screen.getByRole('main')).toBeVisible()
    await expect(screen.getByRole('heading', 'Now', { level: 1 })).toBeVisible()
    await expect(screen.getByRole('search')).toBeVisible()
    await expect(screen.getByRole('searchbox', 'Search tasks')).toBeVisible()
    await expect(screen.getByRole('main').getByRole('link', 'All tasks')).toHaveAttribute('href', /\/tasks$/)
  })

  test('before any task the home is the first-run welcome', async ({ app, screen, browser }) => {
    await stubNoRuns(browser)
    const prefix = await projectPrefix(app, browser)
    await app.open(`${prefix}/`)
    await expect(screen.getByRole('heading', 'What should we build?')).toBeVisible()
    await expect(screen.getByRole('main').getByRole('textbox', 'Describe a task for the agent')).toBeVisible()
    await expect(screen.getByRole('button', 'Continue to the composer')).toBeVisible()
    // The welcome offers the fixture's own history as starting points.
    await expect(screen.getByText('Or continue recent work')).toBeVisible()
    await expect(screen.getByRole('link', /^Wrap the entry point in main\(\)/)).toBeVisible()
    // No triage sections while there is nothing to triage.
    await expect(screen.getByRole('region', /^Needs you/)).toHaveCount(0)
  })

  test('the welcome textbox hands the draft to the composer', async ({ app, screen, browser }) => {
    await stubNoRuns(browser)
    const prefix = await projectPrefix(app, browser)
    await app.open(`${prefix}/`)
    const draft = taskTitle('welcome draft')
    await screen.getByRole('main').getByRole('textbox', 'Describe a task for the agent').fill(draft)
    await screen.getByRole('button', 'Continue to the composer').tap()
    await expect(browser).toHaveURL(/\/p\/[^/]+\/new/)
    await expect(screen.getByRole('textbox', 'Describe a task for the agent')).toHaveValue(draft)
  })

  test('the search box hands its query to the tasks table', async ({ app, screen, browser }) => {
    await app.open('/')
    await screen.getByRole('searchbox', 'Search tasks').fill('greeting')
    await screen.getByRole('searchbox', 'Search tasks').press('Enter')
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks\?q=greeting$/)
    await expect(screen.getByRole('textbox', 'Search tasks')).toHaveValue('greeting')
  })

  test('a started task lands under Needs you with its reason and one action', { timeout: 180_000 }, async ({ app, screen, browser }) => {
    const title = taskTitle('now')
    const { runId, prefix, status } = await createMockTask(app, screen, browser, title)
    expect(status).toBe('needs you')
    await app.open(`${prefix}/`)
    await expect(screen.getByRole('heading', 'Now', { level: 1 })).toBeVisible()
    const needsYou = screen.getByRole('region', /^Needs you/)
    await expect(needsYou).toBeVisible()
    const row = browser.locator(`[data-slot="now-row"][data-run-id="${runId}"]`)
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('data-reason', 'waiting')
    await expect(row.getByRole('link', title)).toHaveAttribute('href', new RegExp(`/tasks/${runId}$`))
    await expect(row.getByText('Paused, waiting for your reply', { exact: false })).toBeVisible()
    // The attention tone is the dot's job: blue for "waiting on a person", never the accent.
    await expect(browser.locator(`[data-slot="now-row"][data-run-id="${runId}"] [data-slot="status-dot"]`)).toHaveAttribute('data-tone', 'info')
    await expect(row.getByText('$0.03')).toBeVisible()
    // Other tests share this server, so the Running / Finished sections only have to exist.
    await expect(screen.getByRole('region', /^Running/)).toBeVisible()
    await expect(screen.getByRole('region', /^Finished today/)).toBeVisible()
    // The sidebar's Now badge counts the same row.
    await expect(screen.getByRole('navigation', 'Main').getByRole('link', /^Now \d+$/)).toBeVisible()

    const action = row.getByRole('link', 'Reply')
    await expect(action).toHaveAttribute('data-action', 'reply')
    await action.tap()
    await expect(browser).toHaveURL(new RegExp(`/tasks/${runId}#reply$`))
    await expect(screen.getByRole('textbox', 'Reply to the agent')).toBeVisible()
  })

  test('the row title opens the task thread', { timeout: 180_000 }, async ({ app, screen, browser }) => {
    const title = taskTitle('now open')
    const { runId, prefix } = await createMockTask(app, screen, browser, title)
    await app.open(`${prefix}/`)
    const row = browser.locator(`[data-slot="now-row"][data-run-id="${runId}"]`)
    await row.getByRole('link', title).tap()
    await expect(browser).toHaveURL(new RegExp(`/tasks/${runId}$`))
    await expect(screen.getByRole('heading', title)).toBeVisible()
  })

  test('on a phone the header folds into the top bar and a New task button floats', { timeout: 180_000 }, async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 })
    const title = taskTitle('now phone')
    const { runId, prefix } = await createMockTask(app, screen, browser, title)
    await app.open(`${prefix}/`)
    await expect(screen.getByRole('main')).toBeVisible()
    // The desktop header (h1 + search) is hidden below `md`; the shell's top bar names the page.
    await expect(screen.getByRole('heading', 'Now', { level: 1, visible: true })).toHaveCount(0)
    await expect(screen.getByRole('button', 'Open menu')).toBeVisible()
    const row = browser.locator(`[data-slot="now-row"][data-run-id="${runId}"]`)
    await expect(row).toBeVisible()
    await expect(row.getByRole('link', 'Reply')).toBeVisible()
    await screen.getByRole('main').getByRole('link', 'New task').tap()
    await expect(browser).toHaveURL(/\/p\/[^/]+\/new$/)
  })
})
