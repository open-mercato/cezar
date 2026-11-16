import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

test('available space selects one navigation and resizing releases the drawer', { trace: 'on' }, async ({ app, browser, screen }) => {
  await app.open('/manager?all=1')
  const bar = screen.getByRole('navigation', 'App', { exact: true })
  const sidebar = browser.locator('[data-slot="sidebar"]')
  await expect(sidebar).toBeVisible()
  await expect(bar).toBeHidden()
  await app.screenshot('wide-desktop-navigation')
  for (const width of [1023, 834, 600, 390]) {
    await browser.setViewport({ width, height: 900 })
    await expect(bar).toBeVisible()
    await expect(sidebar).toBeHidden()
    await expect(screen.getByRole('button', 'Open menu', { exact: true })).toBeVisible()
    expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await app.screenshot(`compact-navigation-${width}`)
  }
  await browser.setViewport({ width: 834, height: 900 })
  const more = screen.getByRole('button', 'More', { exact: true })
  await more.focus()
  await browser.keyboard.press('Enter')
  await expect(screen.getByRole('dialog', 'Navigation')).toBeVisible()
  await browser.keyboard.press('Escape')
  await expect(screen.getByRole('dialog', 'Navigation')).toBeHidden()
  await screen.getByRole('button', 'Open menu', { exact: true }).focus()
  await browser.keyboard.press('Enter')
  await expect(screen.getByRole('dialog', 'Navigation')).toBeVisible()
  await browser.setViewport({ width: 1280, height: 900 })
  await expect(screen.getByRole('dialog', 'Navigation')).toBeHidden()
  await expect(sidebar).toBeVisible()
  await expect(bar).toBeHidden()
  // A narrow containing surface in a wide desktop viewport follows the same rule.
  await browser.evaluate(() => {
    document.querySelector<HTMLElement>('[data-slot="app-shell"]')!.style.width = '700px'
  })
  await expect(bar).toBeVisible()
  await expect(sidebar).toBeHidden()
  await app.screenshot('compact-container-700')
})
