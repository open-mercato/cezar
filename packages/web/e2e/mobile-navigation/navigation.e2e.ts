import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

const artifacts = process.env.CEZ_ARTIFACTS_DIR ?? resolve(import.meta.dirname, '../../../../.e2e/mobile-navigation')
test('responsive Manager directory and modal controls', { timeout: 120000 }, async ({ app, browser, screen }) => {
  mkdirSync(artifacts, { recursive: true })
  const results = []
  await browser.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'CezarMobile/0.1 (ios)' }))
  for (const [width, height] of [[320,480], [375,812], [360,640], [640,360], [768,1024], [1024,768], [507,768], [694,768], [600,400], [900,600]] as const) {
    await browser.setViewport({ width, height })
    await app.open('/e2e/mobile-navigation/index.html')
    await expect(screen.getByRole('link', 'Switch computer: Studio Mac')).toBeVisible()
    await expect(screen.getByRole('link', /Global Manager/)).toBeVisible()
    const directory = await app.screenshot('directory-' + width + 'x' + height)
    copyFileSync(directory, resolve(artifacts, 'directory-' + width + 'x' + height + '.png'))
    await screen.getByRole('button', 'Tasks', { exact: true }).tap()
    await expect(screen.getByRole('dialog', 'Tasks · Global Manager')).toBeVisible()
    await expect(screen.getByRole('button', 'Close', { exact: true })).toBeVisible()
    await expect(screen.getByRole('link', 'View all tasks', { exact: true })).toBeVisible()
    await browser.evaluate(async () => { await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))); return true })
    const bounds = await browser.evaluate(() => {
      const rect = document.querySelector('[data-slot="manager-watching-sheet"]')!.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, right: rect.right, left: rect.left, overflow: document.documentElement.scrollWidth > innerWidth }
    })
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(height + 1)
    expect(bounds.right).toBeLessThanOrEqual(width + 1)
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.overflow).toBe(false)
    expect(await browser.evaluate(() => document.body.style.pointerEvents)).toBe('none')
    await browser.keyboard.press('Tab')
    expect(await browser.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true)
    const shot = await app.screenshot('tasks-' + width + 'x' + height)
    copyFileSync(shot, resolve(artifacts, 'tasks-' + width + 'x' + height + '.png'))
    await screen.getByRole('button', 'Close', { exact: true }).tap()
    await expect(screen.getByRole('dialog')).toHaveCount(0)
    results.push({ width, height, ...bounds })
  }
  // A single mounted modal adapts during a window resize, and keyboard dismissal restores focus.
  await browser.setViewport({ width: 768, height: 1024 })
  await app.open('/e2e/mobile-navigation/index.html')
  await screen.getByRole('button', 'Tasks', { exact: true }).tap()
  await browser.setViewport({ width: 375, height: 640 })
  await expect(screen.getByRole('dialog')).toHaveCount(1)
  await browser.keyboard.press('Escape')
  await expect(screen.getByRole('dialog')).toHaveCount(0)
  expect(await browser.evaluate(() => document.activeElement?.textContent ?? null)).toBe('Tasks')
  await screen.getByRole('button', 'Tasks', { exact: true }).tap()
  await browser.evaluate(async () => { await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))); return true })
  const handle = await browser.evaluate(() => {
    const r = document.querySelector('[data-slot="sheet-header"]')!.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + 8 }
  })
  await browser.mouse.move(handle.x, handle.y)
  await browser.mouse.down()
  await browser.mouse.move(handle.x, handle.y + 100)
  await browser.mouse.up()
  await expect(screen.getByRole('dialog')).toHaveCount(0)
  // Text enlargement and a simulated visual viewport check web geometry; native IME remains hardware QA.
  await browser.evaluate(() => { document.documentElement.style.fontSize = '32px'; return true })
  await screen.getByRole('button', 'Tasks', { exact: true }).tap()
  await expect(screen.getByRole('button', 'Close', { exact: true })).toBeVisible()
  const largeText = await app.screenshot('tasks-large-text')
  copyFileSync(largeText, resolve(artifacts, 'tasks-large-text.png'))
  await browser.evaluate(() => {
    const viewport = Object.assign(new EventTarget(), { width: 375, height: 300, offsetTop: 0 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    window.dispatchEvent(new Event('resize'))
    return true
  })
  await expect(screen.getByRole('link', 'View all tasks', { exact: true })).toBeVisible()
  expect(await browser.evaluate(() => document.querySelector('[data-slot="manager-watching-sheet"]')!.getBoundingClientRect().height)).toBeLessThanOrEqual(300)
  writeFileSync(resolve(artifacts, 'viewport-results.json'), JSON.stringify(results, null, 2))
})
