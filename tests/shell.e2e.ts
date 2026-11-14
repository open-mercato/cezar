import { describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

import { createMockTask, projectPrefix, taskTitle } from './helpers/cockpit'

// The ⌘K chord: the app accepts the platform's command key, so the test sends the same one.
const PALETTE_CHORD = process.platform === 'darwin' ? 'Meta+k' : 'Control+k'

/** A nav row's name grows a count badge ("Now 1") once a task needs you — match the label only. */
const rowNamed = (label: string) => new RegExp(`^${label}(\\s|$)`)

describe('shell', { tags: ['shell'] }, () => {
  test('the sidebar frames the page with its two navigation landmarks', async ({ app, screen }) => {
    await app.open('/')
    await expect(screen.getByRole('main')).toBeVisible()
    const main = screen.getByRole('navigation', 'Main')
    await expect(main).toBeVisible()
    for (const label of ['Now', 'Tasks', 'Git', 'Automations', 'Skills', 'Workflows']) {
      await expect(main.getByRole('link', rowNamed(label))).toBeVisible()
    }
    const workspace = screen.getByRole('navigation', 'Workspace')
    await expect(workspace).toBeVisible()
    for (const label of ['Dashboard', 'All tasks', 'Settings']) {
      await expect(workspace.getByRole('link', rowNamed(label))).toBeVisible()
    }
    // Manager is reached through the Projects | Manager switch on top, not a Workspace row.
    await expect(workspace.getByRole('link', rowNamed('Manager'))).toHaveCount(0)
    const mode = screen.getByRole('navigation', 'Mode')
    await expect(mode.getByRole('link', /^Projects/)).toHaveAttribute('aria-current', 'page')
    await expect(mode.getByRole('link', /^Manager/)).toBeVisible()
    await expect(screen.getByRole('complementary').getByRole('link', 'New task')).toBeVisible()
  })

  test('every project area link opens its page under the project scope', async ({ app, screen, browser }) => {
    // Not `/`: it resumes the last location, which on a shared server may be the workspace-wide
    // All-tasks page, where the project links have no project to scope to.
    const prefix = await projectPrefix(app, browser)
    await app.open(`${prefix}/`)
    const main = screen.getByRole('navigation', 'Main')
    const areas: Array<[string, RegExp, () => Promise<void>]> = [
      ['Tasks', /\/p\/[^/]+\/tasks$/, () => expect(screen.getByRole('heading', 'Tasks', { level: 1 })).toBeVisible()],
      ['Git', /\/p\/[^/]+\/git$/, () => expect(screen.getByRole('heading', 'Git', { level: 1 })).toBeVisible()],
      ['Automations', /\/p\/[^/]+\/automations$/, () => expect(screen.getByRole('heading', 'Automations', { level: 1 })).toBeVisible()],
      ['Skills', /\/p\/[^/]+\/skills$/, () => expect(screen.getByRole('heading', 'Skills', { level: 1 })).toBeVisible()],
      // The workflow editor has no page heading: its "Open workflow" picker is the landmark.
      ['Workflows', /\/p\/[^/]+\/workflows$/, () => expect(screen.getByRole('combobox', 'Open workflow')).toBeVisible()],
      ['Now', /\/p\/[^/]+\/$/, () => expect(screen.getByRole('heading', 'Now', { level: 1 })).toBeVisible()],
    ]
    for (const [label, url, check] of areas) {
      await main.getByRole('link', rowNamed(label)).tap()
      await expect(browser).toHaveURL(url)
      await expect(screen.getByRole('main')).toBeVisible()
      await check()
      await expect(main.getByRole('link', rowNamed(label))).toHaveAttribute('aria-current', 'page')
    }
  })

  test('the Workspace group opens the cross-project pages', async ({ app, screen, browser }) => {
    await app.open('/')
    const workspace = screen.getByRole('navigation', 'Workspace')
    await workspace.getByRole('link', 'Dashboard').tap()
    await expect(browser).toHaveURL(/\/dashboard/)
    await expect(screen.getByRole('heading', 'Dashboard', { level: 1 })).toBeVisible()

    await workspace.getByRole('link', 'All tasks').tap()
    await expect(browser).toHaveURL(/\/tasks(\?.*)?$/)
    await expect(screen.getByRole('heading', 'All tasks', { level: 1 })).toBeVisible()

    await workspace.getByRole('link', 'Settings').tap()
    await expect(browser).toHaveURL(/\/p\/[^/]+\/settings$/)
    await expect(screen.getByRole('navigation', 'Settings sections')).toBeVisible()
  })

  test('the New task button and the C key open the composer', async ({ app, screen, browser }) => {
    const prefix = await projectPrefix(app, browser)
    await screen.getByRole('complementary').getByRole('link', 'New task').tap()
    await expect(browser).toHaveURL(/\/p\/[^/]+\/new$/)
    await expect(screen.getByRole('textbox', 'Describe a task for the agent')).toBeVisible()

    // The flat `/` would resume the composer (last location); the scoped root is the home.
    await app.open(`${prefix}/`)
    await expect(screen.getByRole('heading', 'Now', { level: 1 })).toBeVisible()
    // Focus is on the document, not a field, so the bare letter is the create accelerator.
    await browser.keyboard.press('c')
    await expect(browser).toHaveURL(/\/p\/[^/]+\/new$/)
  })

  test('the command palette opens from the keyboard, filters and navigates', async ({ app, screen, browser }) => {
    await app.open('/')
    await expect(screen.getByRole('heading', 'Now', { level: 1 })).toBeVisible()
    await browser.keyboard.press(PALETTE_CHORD)
    const palette = screen.getByRole('dialog', 'Command palette')
    await expect(palette).toBeVisible()
    const input = palette.getByRole('combobox')
    await expect(input).toBeFocused()
    // Unfiltered, the first row is New task: Enter on an empty query starts a task.
    const newTask = palette.getByRole('option', /^New task/)
    await expect(newTask).toBeVisible()
    await expect(newTask).toHaveAttribute('aria-selected', 'true')
    await expect(palette.getByRole('option', 'Now')).toBeVisible()
    await input.fill('workfl')
    await expect(palette.getByRole('option', 'Workflows')).toBeVisible()
    await expect(newTask).toHaveCount(0)
    await input.press('Enter')
    await expect(browser).toHaveURL(/\/p\/[^/]+\/workflows$/)
    await expect(palette).toBeHidden()
  })

  test('the sidebar Search button opens the palette and Escape closes it', async ({ app, screen, browser }) => {
    await app.open('/')
    await screen.getByRole('complementary').getByRole('button', /^Search tasks/).tap()
    const palette = screen.getByRole('dialog', 'Command palette')
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox').fill('zzz nothing matches this')
    await expect(palette.getByText('Nothing matches.')).toBeVisible()
    await browser.keyboard.press('Escape')
    await expect(palette).toBeHidden()
  })

  test('Current tasks lists a task once one is started', { timeout: 180_000 }, async ({ app, screen, browser }) => {
    const title = taskTitle('shell')
    const { runId, prefix } = await createMockTask(app, screen, browser, title)
    const current = browser.locator('[data-slot="current-tasks"]')
    await expect(current.getByRole('heading', 'Current tasks')).toBeVisible()
    const row = current.getByRole('link', new RegExp(`^${title}\\b`))
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('aria-current', 'page')
    // Pin it: the list shows six rows, and other files on this server keep starting newer tasks.
    const item = browser.locator('[data-slot="current-tasks"] [data-slot="task-row"]').filter({ hasText: title })
    await item.hover()
    await item.getByRole('button', 'Pin task').tap()
    await app.open(`${prefix}/`)
    await expect(row).toBeVisible()
    await expect(row).not.toHaveAttribute('aria-current', 'page')
    await row.tap()
    await expect(browser).toHaveURL(new RegExp(`/tasks/${runId}$`))
    await expect(current.getByRole('link', 'More…')).toHaveAttribute('href', /\/tasks$/)
  })

  test('an unknown route under the project renders the not-found state', async ({ app, screen, browser }) => {
    const prefix = await projectPrefix(app, browser)
    await app.open(`${prefix}/zzz-not-a-route`)
    await expect(screen.getByRole('main')).toBeVisible()
    await expect(screen.getByRole('heading', 'Page not found', { level: 1 })).toBeVisible()
    await expect(screen.getByRole('navigation', 'Main')).toBeVisible()
    // "Back to tasks" means the tasks table, not Now (the project root).
    await screen.getByRole('link', 'Back to tasks').tap()
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks$/)
  })

  test('a phone gets a top bar whose menu opens the navigation drawer', async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 390, height: 844 })
    await app.open('/')
    await expect(screen.getByRole('main')).toBeVisible()
    await expect(screen.getByRole('navigation', 'Main', { visible: true })).toHaveCount(0)
    await screen.getByRole('button', 'Open menu').tap()
    const drawer = screen.getByRole('dialog', 'Navigation')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('navigation', 'Main')).toBeVisible()
    await expect(drawer.getByRole('navigation', 'Workspace')).toBeVisible()
    await drawer.getByRole('navigation', 'Main').getByRole('link', rowNamed('Tasks')).tap()
    await expect(browser).toHaveURL(/\/p\/[^/]+\/tasks$/)
    await expect(drawer).toBeHidden()
    await screen.getByRole('button', 'Open menu').tap()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', 'Close menu').tap()
    await expect(drawer).toBeHidden()
    await expect(screen.getByRole('button', 'Open menu')).toBeFocused()
  })
})
