import { beforeEach, describe, test } from '@e2e-dev/web'
import { expect } from 'e2e'

// UI-only fixtures: no delivery is sent and no signing material is generated.
const receiver = { kind: 'live', id: 'review-fixture', name: 'Review fixture', format: 'cezar.json.v1', destination: 'https://receiver.invalid/', state: 'active', revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 1, inFlightCount: 1, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false }
describe('fixture UI guards', () => {
  beforeEach(async ({ browser }) => {
    await browser.route(/\/api\/v1\/(?:p\/[^/]+\/)?webhooks(?:\?.*)?$/, route => route.fulfill({ json: { receivers: [receiver], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }))
    await browser.route(/\/webhooks\/review-fixture\/deliveries/, route => route.fulfill({ json: { receiver, items: [{ deliveryId: 'delivery-fixture', eventId: 'event-fixture', eventType: 'task.finished', status: 'retrying', createdAt: '2026-10-01T00:00:00Z', attempts: 1, retryAllowed: true, replayAllowed: true }], total: 1, hasMore: false, timezone: 'UTC' } }))
  })

  test('delayed Send test preserves the Add draft opened while it waits', async ({ app, screen, browser }) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    await browser.route(/\/webhooks\/review-fixture\/test$/, async route => {
      await gate
      await route.fulfill({ json: { deliveryId: 'test-fixture' } })
    })
    await app.open('/p/default/settings/webhooks')
    await screen.getByRole('button', 'Send test').tap()
    await expect(screen.getByRole('button', 'Send test')).toBeDisabled()
    await screen.getByRole('button', 'Add receiver').tap()
    await screen.getByLabel('Name').fill('Draft survives test completion')
    await screen.getByLabel('Receiver URL').fill('https://receiver.invalid/draft')
    release()
    await expect(screen.getByRole('button', 'Save receiver')).toBeEnabled()
    await expect(screen.getByLabel('Name')).toHaveValue('Draft survives test completion')
    await expect(screen.getByLabel('Receiver URL')).toHaveValue('https://receiver.invalid/draft')
  })

  for (const dismissal of ['Cancel', 'Escape']) {
    test(`nested Retry ${dismissal} returns keyboard focus to History`, async ({ app, screen, browser }) => {
      await app.open('/p/default/settings/webhooks?endpoint=review-fixture&tab=deliveries')
      await screen.getByRole('button', /Task finished/).tap()
      await screen.getByRole('button', 'Retry now').tap()
      await expect(screen.getByRole('dialog', 'Retry this delivery now?')).toBeVisible()
      if (dismissal === 'Cancel') await screen.getByRole('button', 'Cancel').tap()
      else await browser.keyboard.press('Escape')
      await expect(screen.getByRole('dialog', 'Retry this delivery now?')).toHaveCount(0)
      await expect(screen.getByRole('button', 'Retry now')).toBeFocused()
      await browser.keyboard.press('Tab')
      await expect(screen.getByRole('button', 'Replay')).toBeFocused()
    })
  }

})

// Real API race: only hold the Test request; the server produces the revision 409.
test('delayed test 409 must not block a new Add draft', async ({ app, screen, browser }) => {
  if (!app.baseUrl) throw new Error('Expected the disposable webhook server URL')
  const base = app.baseUrl.replace(/\/$/, '') + '/api/v1/p/default/webhooks'
  const created = await fetch(base, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Delayed conflict', url: 'https://receiver.invalid/fixture' }),
  })
  expect(created.status).toBe(201)
  const { receiver } = await created.json()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = false
  await browser.route('**/webhooks/' + receiver.id + '/test', async route => {
    started = true
    await gate
    await route.continue()
  })
  await app.open('/p/default/settings/webhooks')
  await screen.getByRole('article').filter({ hasText: receiver.name }).getByRole('button', 'Send test').tap()
  await expect.poll(() => started).toBe(true)
  await screen.getByRole('button', 'Add receiver').tap()
  await screen.getByLabel('Name').fill('Unrelated draft')
  await screen.getByLabel('Receiver URL').fill('https://receiver.invalid/new')
  const changed = await fetch(base + '/' + receiver.id, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Changed in another tab', expectedRevision: receiver.revision }),
  })
  expect(changed.status).toBe(200)
  release()
  await expect(screen.getByRole('button', 'Save receiver')).toBeEnabled()
  await expect(screen.getByRole('dialog')).not.toContainText('Receiver revision changed; refresh and try again')
  await expect(screen.getByText('Earlier webhook action failed: Receiver revision changed; refresh and try again')).toBeVisible()
  await app.screenshot('delayed-conflict')
  await expect(screen.getByLabel('Name')).toHaveValue('Unrelated draft')
  await expect(screen.getByLabel('Receiver URL')).toHaveValue('https://receiver.invalid/new')
  await screen.getByRole('button', 'Save receiver').tap()
  await expect(screen.getByRole('dialog', 'Save your signing key')).toBeVisible()
  await screen.getByRole('button', 'I’ve saved the key').tap()
  await expect(screen.getByRole('article').filter({ hasText: 'Unrelated draft' })).toBeVisible()
})
