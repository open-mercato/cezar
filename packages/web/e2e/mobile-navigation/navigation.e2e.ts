import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

const artifacts = resolve(import.meta.dirname, '../../../../.e2e/mobile-navigation')
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
    await browser.evaluate(async () => { await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))); return true })
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
  await browser.evaluate(async () => { await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))); return true })
  const handle = await browser.evaluate(() => {
    const r = document.querySelector('[data-slot="sheet-header"]')!.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + 8 }
  })
  await browser.mouse.move(handle.x, handle.y)
  await browser.mouse.down()
  await browser.mouse.move(handle.x, handle.y + 100)
  await browser.mouse.up()
  await expect(screen.getByRole('dialog')).toHaveCount(0)
  // A simulated visual viewport checks web geometry; native IME remains hardware QA.
  await screen.getByRole('button', 'Tasks', { exact: true }).tap()
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


// Content can grow before opening (OS text size) or while open (browser text scaling).
for (const timing of ['before opening', 'while open'] as const) {
  test(`enlarged Tasks fits controls and task rows when text grows ${timing}`, async ({ app, browser, screen }) => {
    mkdirSync(artifacts, { recursive: true })
    await browser.setViewport({ width: 375, height: 640 })
    await app.open('/e2e/mobile-navigation/index.html')
    if (timing === 'before opening') {
      await browser.evaluate(() => { document.documentElement.style.fontSize = '32px'; return true })
    }
    await screen.getByRole('button', 'Tasks', { exact: true }).tap()
    await expect(screen.getByRole('dialog', 'Tasks · Global Manager')).toBeVisible()
    if (timing === 'while open') {
      await browser.evaluate(async () => { await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))); return true })
      expect(await browser.evaluate(() => document.querySelector('[role="dialog"]')!.getBoundingClientRect().height)).toBe(384)
      await browser.evaluate(() => { document.documentElement.style.fontSize = '32px'; return true })
    }
    // Let content measurement and the opening animation settle before reading actual bounds.
    await browser.evaluate(async () => {
      await document.fonts.ready
      await new Promise(requestAnimationFrame)
      await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))
      await new Promise(requestAnimationFrame)
      return true
    })
    const geometry = await browser.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')!
      const body = dialog.querySelector<HTMLElement>('[data-touch]')!
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height }
      }
      const padding = getComputedStyle(body)
      return {
        dialog: rect(dialog),
        close: rect([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Close')!),
        footer: rect(dialog.querySelector(':scope > a')!),
        task: rect(body.querySelector('[data-slot="manager-watching-task"]')!),
        body: rect(body),
        usableBody: body.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom),
      }
    })
    const suffix = timing === 'before opening' ? 'initial' : 'resize'
    writeFileSync(resolve(artifacts, `large-text-${suffix}-geometry.json`), JSON.stringify(geometry, null, 2))
    copyFileSync(await app.screenshot(`large-text-${suffix}-settled`), resolve(artifacts, `large-text-${suffix}-settled.png`))
    expect(geometry.close.top).toBeGreaterThanOrEqual(0)
    expect(geometry.close.bottom).toBeLessThanOrEqual(640)
    expect(geometry.footer.bottom).toBeLessThanOrEqual(640)
    expect(geometry.dialog.height).toBeGreaterThan(384)
    expect(geometry.usableBody).toBeGreaterThanOrEqual(128)
    expect(geometry.task.top).toBeGreaterThanOrEqual(geometry.body.top)
    expect(geometry.task.bottom).toBeLessThanOrEqual(geometry.body.bottom)
  })
}


// The directory search used to collapse to a few letters beside the filter at enlarged text.
test('directory search and Needs you filter stay usable at normal and 200% text', async ({ app, browser, screen }) => {
  mkdirSync(artifacts, { recursive: true })
  await browser.setViewport({ width: 375, height: 812 })
  for (const fontSize of ['16px', '32px'] as const) {
    await app.open('/e2e/mobile-navigation/index.html')
    await browser.evaluate((size) => { document.documentElement.style.fontSize = size; return true }, fontSize)
    await expect(screen.getByRole('textbox', 'Search managers or device')).toBeVisible()
    const geometry = await browser.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const search = rect('input[aria-label="Search managers or device"]')
      const filter = rect('[data-slot="manager-needs-you-filter"]')
      const list = rect('[data-route="manager-list"]')
      return { search: { width: search.width, top: search.top }, filter: { height: filter.height, top: filter.top }, list: { width: list.width }, overflow: document.documentElement.scrollWidth > innerWidth }
    })
    writeFileSync(resolve(artifacts, `directory-toolbar-${fontSize}.json`), JSON.stringify(geometry, null, 2))
    expect(geometry.overflow).toBe(false)
    expect(geometry.filter.height).toBeGreaterThanOrEqual(44)
    if (fontSize === '16px') {
      // One row at normal size: the filter sits beside the search.
      expect(geometry.filter.top).toBe(geometry.search.top)
    } else {
      // Wrapped: the search keeps the row to itself instead of shrinking to a few letters.
      expect(geometry.filter.top).toBeGreaterThan(geometry.search.top)
      expect(geometry.search.width).toBeGreaterThan(geometry.list.width * 0.8)
    }
  }
})


test('late task sections expand an initially empty medium sheet', async ({ app, browser, screen }) => {
  mkdirSync(artifacts, { recursive: true })
  await browser.setViewport({ width: 375, height: 640 })
  await app.open('/e2e/mobile-navigation/index.html?empty=1')
  await browser.evaluate(() => { document.documentElement.style.fontSize = '20px'; return true })
  await screen.getByRole('button', 'Tasks', { exact: true }).tap()
  await expect(screen.getByRole('dialog')).toBeVisible()
  await browser.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))
    return true
  })
  expect(await browser.evaluate(() => document.querySelector('[role="dialog"]')!.getBoundingClientRect().height)).toBe(384)
  await expect(screen.getByRole('heading', 'Tasks it started', { exact: true })).toHaveCount(0)
  await browser.evaluate(() => { window.dispatchEvent(new Event('fixture:tasks-ready')); return true })
  await expect(screen.getByRole('heading', 'Tasks it started', { exact: true })).toBeVisible()
  await browser.evaluate(async () => {
    await document.fonts.ready
    await new Promise(requestAnimationFrame)
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))
    await new Promise(requestAnimationFrame)
    return true
  })
  const geometry = await browser.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')!
    const body = dialog.querySelector('[data-touch]')!
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height }
    }
    return {
      dialog: rect(dialog), body: rect(body),
      rows: [...body.querySelectorAll('[data-slot="manager-watching-task-row"]')].map(rect),
      footer: rect(dialog.querySelector('[data-slot="manager-watching-sheet-all-tasks"]')!),
    }
  })
  writeFileSync(resolve(artifacts, 'late-tasks-geometry.json'), JSON.stringify(geometry, null, 2))
  copyFileSync(await app.screenshot('late-tasks-settled'), resolve(artifacts, 'late-tasks-settled.png'))
  expect(geometry.dialog.height).toBeGreaterThan(384)
  expect(geometry.rows).toHaveLength(2)
  expect(geometry.rows[1]!.bottom).toBeLessThanOrEqual(geometry.body.bottom)
  expect(geometry.footer.bottom).toBeLessThanOrEqual(640)
})
