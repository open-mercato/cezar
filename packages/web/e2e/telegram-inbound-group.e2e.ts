import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
// Its own fixture instance (telegram-inbound-group.config.ts): the group is the first chat this bot serves.
test('the Add to a group link connects a group for notifications only, behind the visibility consent', async ({ app, screen }) => {
  await app.open('/p/default/settings/integrations?integration=telegram')
  await screen.getByRole('button', /^(Connect Telegram|Add a chat)$/).tap()
  // The fixture answers a setup named "Group …" with /start from the group "Fixture team".
  await screen.getByLabel('Notification name').fill('Group alerts')
  await screen.getByLabel('Bot token').fill(`123456:${'x'.repeat(35)}`)
  await screen.getByRole('checkbox', 'This bot is dedicated to this project: no other application receives its messages.').check()
  await screen.getByRole('button', 'Continue').tap()
  await expect(screen.getByRole('link', 'Add to a group')).toBeVisible()
  await expect(screen.getByText(/Forum groups \(with topics\) are not supported/)).toBeVisible()
  await expect(screen.getByText(/started by Group person/)).toBeVisible()
  await expect(screen.getByRole('button', 'Activate notifications')).toBeDisabled()
  await screen.getByRole('checkbox', /all members of this group can read project messages/).check()
  await screen.getByRole('button', 'Activate notifications').tap()
  await expect(screen.getByRole('heading', 'Telegram notifications are active')).toBeVisible()
  await screen.getByRole('checkbox', /Enable optional task control/).check()
  await screen.getByRole('button', 'Skip task control').tap()
  await expect(screen.getByText(/task control is off/)).toBeVisible()
  await screen.getByRole('button', 'Done').tap()

  if (!app.baseUrl) throw new Error('Expected the disposable Telegram fixture server URL')
  const base = app.baseUrl.replace(/\/$/, '')
  const { receivers } = await fetch(`${base}/api/v1/webhooks`).then(response => response.json()) as { receivers: Array<{ name: string; telegramChatId?: string; state: string }> }
  expect(receivers.find(row => row.name === 'Group alerts')).toMatchObject({ telegramChatId: '-777', state: 'active' })
})
