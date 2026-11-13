import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

import { createMockTask, expectRowOrder, projectPrefix, stubNoRuns, taskTitle, waitForRunStatus } from './helpers/cockpit'

/** The project's own tasks table lives under the scope; the flat `/tasks` is "All tasks". */
async function openTasks(app: Parameters<typeof projectPrefix>[0], browser: Parameters<typeof projectPrefix>[1], query = '') {
  const prefix = await projectPrefix(app, browser)
  await app.open(`${prefix}/tasks${query}`)
  return prefix
}

describe('tasks overview', { tags: ['tasks-overview'] }, () => {
  test('opens with the Tasks header, the view tabs and the search', async ({ app, screen, browser }) => {
    await openTasks(app, browser)
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks$/)
    await expect(screen.getByRole('main')).toBeVisible()
    await expect(screen.getByRole('heading', 'Tasks', { level: 1 })).toBeVisible()
    await expect(screen.getByRole('button', /^Active/)).toHaveAttribute('aria-pressed', 'true')
    await expect(screen.getByRole('button', /^Archived/)).toHaveAttribute('aria-pressed', 'false')
    await expect(screen.getByRole('textbox', 'Search tasks')).toBeVisible()
    await expect(screen.getByRole('navigation', 'Main').getByRole('link', /^Tasks/)).toHaveAttribute('aria-current', 'page')
  })

  test('before any task the active view is the first-run welcome and the archive is empty', async ({ app, screen, browser }) => {
    await stubNoRuns(browser)
    await openTasks(app, browser)
    await expect(screen.getByRole('heading', 'What should we build?')).toBeVisible()
    await expect(screen.getByRole('main').getByRole('textbox', 'Describe a task for the agent')).toBeVisible()
    // No filter bar over the welcome: there is nothing to narrow.
    await expect(screen.getByRole('group', 'Show tasks started by')).toHaveCount(0)
    await screen.getByRole('button', /^Archived/).tap()
    await expect(screen.getByRole('heading', 'Nothing archived yet')).toBeVisible()
    await expect(screen.getByText('Finished tasks you archive land here.')).toBeVisible()
  })

  test('started tasks fill the table with their status, workflow, diff and cost', { timeout: 240_000 }, async ({ app, screen, browser }) => {
    // One tag for both titles: the search narrows the shared server's table to these two rows,
    // so the virtualised table cannot window them out while other files add rows above.
    const tag = `tbl${Date.now()}`
    const first = taskTitle(`${tag} one`)
    const second = taskTitle(`${tag} two`)
    const a = await createMockTask(app, screen, browser, first)
    const b = await createMockTask(app, screen, browser, second)
    await app.open(`${a.prefix}/tasks`)
    const table = browser.locator('[data-slot="tasks-table"]')
    await expect(table).toBeVisible()
    await screen.getByRole('textbox', 'Search tasks').fill(tag)
    await expect(browser.locator('[data-slot="task-table-row"]')).toHaveCount(2)
    // Foldable headers are named by their fold button ("Fold Workflow column").
    for (const column of ['Status', 'Task', /Workflow column$/, /Cost column$/]) {
      await expect(table.getByRole('columnheader', column)).toBeVisible()
    }
    const rowA = browser.locator(`[data-slot="task-table-row"][data-run-id="${a.runId}"]`)
    const rowB = browser.locator(`[data-slot="task-table-row"][data-run-id="${b.runId}"]`)
    await expect(rowA).toBeVisible()
    await expect(rowB).toBeVisible()
    await expect(rowA.getByRole('link', first)).toHaveAttribute('href', new RegExp(`/tasks/${a.runId}$`))
    // The dry-run agent stops at a question: an open state spells its word next to the dot,
    // in the blue "waiting on a person" tone.
    await expect(rowA.getByRole('cell', 'needs you')).toBeVisible()
    const dot = browser.locator(`[data-slot="task-table-row"][data-run-id="${a.runId}"] [data-slot="status-dot"]`)
    await expect(dot).toHaveAttribute('data-tone', 'info')
    await expect(rowA.getByText('quick-task')).toBeVisible()
    await expect(rowA.getByText('$0.03')).toBeVisible()
    await expect(rowA.getByRole('link', `Open the pull request for ${first}`)).toHaveAttribute('href', /pull\/123$/)
    // Newest first under Recent: the second task leads.
    await expectRowOrder(browser, b.runId, a.runId)
    await expect(screen.getByRole('group', 'Show tasks started by').getByRole('button', /^Regular/)).toHaveAttribute('aria-pressed', 'true')
  })

  test('the Columns menu folds and expands a column and resets to the defaults', { timeout: 180_000 }, async ({ app, screen, browser }) => {
    const { prefix } = await createMockTask(app, screen, browser, taskTitle('columns'))
    await app.open(`${prefix}/tasks`)
    const table = browser.locator('[data-slot="tasks-table"]')
    await expect(table.getByRole('button', 'Fold Workflow column')).toBeVisible()
    await screen.getByRole('button', 'Columns').tap()
    const menu = screen.getByRole('menu', 'Columns')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitemcheckbox', 'Workflow')).toBeChecked()
    await expect(menu.getByRole('menuitemcheckbox', 'Branch')).not.toBeChecked()
    await expect(menu.getByRole('menuitem', 'Reset to defaults')).toBeDisabled()
    await menu.getByRole('menuitemcheckbox', 'Workflow').tap()
    // Folded: the header shrinks to its icon and offers the expand action.
    await expect(table.getByRole('button', 'Expand Workflow column')).toBeVisible()
    await expect(browser.locator('[data-slot="tasks-table"] col[data-column-id="workflow"]')).toHaveAttribute('data-expanded', 'false')
    await screen.getByRole('button', 'Columns').tap()
    await expect(menu.getByRole('menuitemcheckbox', 'Workflow')).not.toBeChecked()
    await expect(menu.getByRole('menuitem', 'Reset to defaults')).toBeEnabled()
    await menu.getByRole('menuitem', 'Reset to defaults').tap()
    await expect(table.getByRole('button', 'Fold Workflow column')).toBeVisible()
    await expect(browser.locator('[data-slot="tasks-table"] col[data-column-id="workflow"]')).toHaveAttribute('data-expanded', 'true')
    // The header's own fold button is the same toggle.
    await table.getByRole('button', 'Fold Workflow column').tap()
    await expect(table.getByRole('button', 'Expand Workflow column')).toBeVisible()
    await table.getByRole('button', 'Expand Workflow column').tap()
    await expect(table.getByRole('button', 'Fold Workflow column')).toBeVisible()
  })

  test('search, the status facet and the sort control narrow and order the table', { timeout: 240_000 }, async ({ app, screen, browser }) => {
    const first = taskTitle('filter alpha')
    const second = taskTitle('filter beta')
    const a = await createMockTask(app, screen, browser, first)
    const b = await createMockTask(app, screen, browser, second)
    await app.open(`${a.prefix}/tasks`)
    const rowA = browser.locator(`[data-slot="task-table-row"][data-run-id="${a.runId}"]`)
    const rowB = browser.locator(`[data-slot="task-table-row"][data-run-id="${b.runId}"]`)
    await expect(rowA).toBeVisible()
    await expect(rowB).toBeVisible()

    const search = screen.getByRole('textbox', 'Search tasks')
    await search.fill('filter beta')
    await expect(rowB).toBeVisible()
    await expect(rowA).toBeHidden()
    await search.fill('zzz no such task')
    await expect(screen.getByRole('heading', 'No matching tasks')).toBeVisible()
    await expect(screen.getByText('No tasks match “zzz no such task”.')).toBeVisible()
    await search.fill('')
    await expect(rowA).toBeVisible()

    await screen.getByRole('button', 'Filter by status').tap()
    const option = screen.getByRole('option', /^waiting/)
    await expect(option).toBeVisible()
    await option.tap()
    await browser.keyboard.press('Escape')
    await expect(rowA).toBeVisible()
    await expect(screen.getByRole('button', /^Clear \(1\)/)).toBeVisible()
    await screen.getByRole('button', /^Clear \(1\)/).tap()
    await expect(screen.getByRole('button', /^Clear \(/)).toHaveCount(0)

    const sort = screen.getByRole('group', 'Sort tasks by')
    await expect(sort.getByRole('button', 'Recent')).toHaveAttribute('aria-pressed', 'true')
    await sort.getByRole('button', 'Created').tap()
    await expect(sort.getByRole('button', 'Created')).toHaveAttribute('aria-pressed', 'true')
    await expectRowOrder(browser, b.runId, a.runId)
  })

  test('a finished task shows the done tone and its quick actions archive and restore it', { timeout: 240_000 }, async ({ app, screen, browser }) => {
    const title = taskTitle('archive me')
    const { runId, prefix } = await createMockTask(app, screen, browser, title)
    // Only a done run is archivable: closing the paused session finishes the run.
    await screen.getByRole('button', 'End session').tap()
    await waitForRunStatus(browser, /^done$/)
    await expect(screen.getByText('· run finished')).toBeVisible()
    await app.open(`${prefix}/tasks`)
    // Narrow the shared server's table to this row, so it sits in view instead of under the
    // sticky header when the quick action is tapped.
    await screen.getByRole('textbox', 'Search tasks').fill(title)
    const row = browser.locator(`[data-slot="task-table-row"][data-run-id="${runId}"]`)
    await expect(row).toBeVisible()
    const dot = browser.locator(`[data-slot="task-table-row"][data-run-id="${runId}"] [data-slot="status-quiet"] [data-slot="status-dot"]`)
    await expect(dot).toHaveAttribute('aria-label', 'done')
    // Done is the green success tone.
    await expect(dot).toHaveAttribute('data-tone', 'success')
    // Hover reveals the leading controls: the select checkbox and the floating quick actions.
    await row.hover()
    await expect(row.getByRole('checkbox', `Select ${title}`)).toBeVisible()
    await expect(row.getByRole('button', new RegExp(`^Mark (read|unread): ${title}$`))).toBeVisible()
    await row.getByRole('button', `Archive: ${title}`).tap()
    await expect(screen.getByRole('status', 'Task action status')).toContainText('Archive: 1 succeeded')
    await expect(row).toHaveCount(0)
    await screen.getByRole('button', /^Archived/).tap()
    await expect(screen.getByRole('button', /^Archived/)).toHaveAttribute('aria-pressed', 'true')
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', `Restore: ${title}`).tap()
    await expect(screen.getByRole('status', 'Task action status')).toContainText('Restore: 1 succeeded')
    await expect(row).toHaveCount(0)
    await screen.getByRole('button', /^Active/).tap()
    await expect(row).toBeVisible()
  })

  test('Select mode offers bulk actions over the displayed tasks', { timeout: 180_000 }, async ({ app, screen, browser }) => {
    const title = taskTitle('select me')
    const { prefix } = await createMockTask(app, screen, browser, title)
    await app.open(`${prefix}/tasks`)
    await screen.getByRole('button', 'Select').tap()
    await screen.getByRole('checkbox', `Select ${title}`).check()
    await expect(screen.getByRole('button', /^Archive \(\d+\)$/)).toBeVisible()
    await screen.getByRole('checkbox', `Select ${title}`).uncheck()
    await expect(screen.getByRole('button', /^Archive \(\d+\)$/)).toHaveCount(0)
  })

  test('a phone stacks the tasks as cards', { timeout: 180_000 }, async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 })
    const title = taskTitle('phone card')
    const { runId, prefix } = await createMockTask(app, screen, browser, title)
    await app.open(`${prefix}/tasks`)
    await expect(screen.getByRole('main')).toBeVisible()
    await expect(browser.locator('[data-slot="tasks-table"]')).toBeHidden()
    const card = browser.locator(`[data-slot="task-card"][data-run-id="${runId}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByRole('link', title)).toHaveAttribute('href', new RegExp(`/tasks/${runId}$`))
    await expect(card.getByText('needs you')).toBeVisible()
    await expect(screen.getByRole('button', 'Columns', { visible: true })).toHaveCount(0)
    await expect(screen.getByRole('main').getByRole('link', 'New task')).toBeVisible()
    await card.getByRole('link', title).tap()
    await expect(browser).toHaveURL(new RegExp(`/tasks/${runId}$`))
  })
})
