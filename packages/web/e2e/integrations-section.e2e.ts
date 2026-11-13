import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

for (const width of [320, 375]) {
  test(`category geometry and keyboard at ${width}`, async ({ app, screen, browser }) => {
    await browser.setViewport({ width, height: 812 })
    await app.open('/p/default/settings/integrations')
    await expect(screen.getByRole('button', 'Configure Jira')).toBeVisible()
    const geometry = await browser.evaluate(() => {
      const group = document.querySelector('[data-slot="integration-category-filter"]')!
      return {
        viewport: innerWidth,
        page: document.documentElement.scrollWidth,
        buttons: Array.from(group.querySelectorAll('button')).map(button => {
          const { left, right } = button.getBoundingClientRect()
          return { left, right }
        }),
      }
    })
    expect(geometry.page).toBeLessThanOrEqual(width)
    expect(geometry.buttons).toHaveLength(5)
    for (const button of geometry.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(0)
      expect(button.right).toBeLessThanOrEqual(width)
    }

    await screen.getByRole('searchbox', 'Search integrations').click()
    for (const category of ['all', 'Chat', 'Issue tracking', 'Testing', 'Webhooks']) {
      await browser.keyboard.press('Tab')
      expect(await browser.evaluate(() => document.activeElement?.getAttribute('data-value') ?? null)).toBe(category)
      await browser.keyboard.press('Enter')
      expect(await browser.evaluate(() => document.activeElement?.getAttribute('aria-pressed') ?? null)).toBe('true')
    }
  })
}

test('disabled installed chat retains recovery and navigates back to its project access', async ({ app, screen }) => {
  const control = new URL(app.baseUrl!)
  control.port = String(Number(control.port) + 1)
  const fixture = await (await fetch(control)).json()
  await app.open('/settings/global/extensions')
  await screen.getByLabel('Extension folder or package').fill(fixture.chat)
  await screen.getByRole('button', 'Preview install').click()
  await screen.getByRole('button', 'Approve and install').click()
  const row = screen.getByRole('listitem', 'Mattermost')
  await expect(row).toBeVisible()
  await row.getByRole('link', 'Manage Mattermost connection').click()
  await expect(screen.getByRole('region', 'Mattermost')).toBeVisible()
  await expect(screen.getByText('Disabled', { exact: true })).toBeVisible()
  await expect(screen.getByRole('button', 'Connect Mattermost', { exact: true })).not.toBeVisible()
  await screen.getByRole('link', 'Manage extension').click()
  await expect(row).toBeVisible()
  await expect(screen.getByRole('combobox', 'Project access')).toHaveAttribute('data-value', 'default')
  await row.getByRole('button', 'Uninstall', { exact: true }).click()
  await expect(screen.getByText(/removes the extension from all projects/)).toBeVisible()
  await expect(screen.getByRole('button', 'Uninstall and keep data')).toBeVisible()
  await screen.getByRole('button', 'Cancel', { exact: true }).click()
})

for (const provider of ['telegram', 'slack', 'discord']) {
  test(`canonical ${provider} keeps one native form and a keyboard-accessible software return link`, async ({ app, screen, browser }) => {
    await browser.setViewport({ width: 375, height: 812 })
    const name = provider[0]!.toUpperCase() + provider.slice(1)
    const response = await fetch(new URL('/api/v1/p/default/extensions/inventory', app.baseUrl!))
    const inventory = await response.json()
    const owner = inventory.extensions.find((item: { providers: { id: string }[] }) => item.providers.some(owned => owned.id === provider))
    expect(Boolean(owner)).toBe(true)
    await app.open('/p/default/settings/integrations')
    await expect(screen.getByRole('button', `Configure ${name}`, { exact: true })).toHaveCount(1)
    await screen.getByRole('button', `Configure ${name}`, { exact: true }).press('Enter')
    await expect(screen.getByRole('region', name, { exact: true })).toHaveCount(1)
    await expect(screen.getByRole('button', 'All integrations')).toBeFocused()
    const projectId = new URL(await browser.url()).pathname.split('/')[2]!
    const link = screen.getByRole('link', 'Manage extension')
    await expect(link).toHaveAttribute('href', `/settings/global/extensions?project=${projectId}&extension=${owner.record.manifest.id}`)
    // The link precedes the existing native form in the keyboard order.
    await browser.keyboard.press('Tab')
    await expect(link).toBeFocused()
    expect(await browser.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)
    await browser.keyboard.press('Enter')
    await expect(screen.getByRole('combobox', 'Project access')).toHaveAttribute('data-value', 'default')
    await expect(browser).toHaveURL(new RegExp(`extension=${owner.record.manifest.id}`))
    await browser.back()
    await expect(screen.getByRole('button', 'All integrations')).toBeFocused()
    await screen.getByRole('button', 'All integrations').click()
    await expect(screen.getByRole('button', `Configure ${name}`, { exact: true })).toBeFocused()
  })
}
