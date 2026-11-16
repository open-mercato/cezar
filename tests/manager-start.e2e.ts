import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

// Engine coverage of the shared cockpit; native cold-launch decisions have their own shell tests.
test('mobile entry completes agent setup at Manager and preserves navigation across reload', { trace: 'on', timeout: 90_000 }, async ({ app, browser, screen }) => {
  const base = app.baseUrl!
  let connected = false
  await browser.route(new URL('/api/v1/providers/status*', base).href, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ providers: [{ provider: 'claude', status: connected ? 'connected' : 'disconnected', enabled: true }] }),
  }))
  await browser.route(new URL('/api/v1/workspace/ui-state', base).href, route => route.fulfill({ contentType: 'application/json', body: '{}' }))
  await browser.route(new URL('/api/v1/providers/setup', base).href, route => route.fulfill({ contentType: 'application/json', body: '{"available":false}' }))
  await browser.route(new URL('/api/v1/workspace/managers', base).href, route => route.fulfill({ contentType: 'application/json', body: '{"managers":[]}' }))
  await app.open('/manager')
  await expect(screen.getByRole('button', 'Check again', { exact: true })).toBeVisible()
  await app.screenshot('agent-setup')
  connected = true
  await screen.getByRole('button', 'Check again', { exact: true }).tap()
  await expect(screen.getByRole('heading', 'Set up your first manager')).toBeVisible()
  await expect(browser).toHaveURL('/manager')
  await app.screenshot('manager-after-setup')
  await browser.reload()
  await expect(screen.getByRole('heading', 'Set up your first manager')).toBeVisible()
  await app.open('/')
  await expect(browser).toHaveURL('/manager')
  await app.screenshot('manager-default-launch')
  await app.open('/settings/agents#providers')
  await expect.poll(() => browser.url()).toMatch(/\/settings\/agents#providers$/)
  const settingsUrl = await browser.url()
  await browser.reload()
  await expect.poll(() => browser.url()).toBe(settingsUrl)
  await expect(screen.getByRole('heading', 'Default runner', { exact: true })).toBeVisible()
  await browser.evaluate(() => history.back())
  await expect(browser).toHaveURL('/manager')
  await expect(screen.getByRole('heading', 'Set up your first manager')).toBeVisible()
})
