import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

// These are deliberately fictional credentials. The fixture forces CEZ_DRY_RUN=1,
// so no webhook request can reach Slack, Discord, or any external destination.
const destinations = [
  { name: 'Slack', format: 'slack.v1', url: 'https://hooks.slack.com/services/T1/B1/test' },
  { name: 'Discord', format: 'discord.v1', url: `https://discord.com/api/webhooks/123456789012345678/${'fictional'.repeat(8)}` },
]

for (const destination of destinations) {
  test(`${destination.name}: hint, profiles, create, test, activate and edit`, async ({ app, screen, browser }) => {
    await app.open('/p/default/settings/webhooks')
    await screen.getByRole('button', 'Add receiver').tap()
    await screen.getByLabel('Name').fill(`${destination.name} browser fixture`)
    await screen.getByLabel('Receiver URL').fill(destination.url)
    await screen.getByRole('button', `Use ${destination.name}`).tap()
    await expect(screen.getByLabel('Destination')).toHaveValue(destination.format)
    await expect(screen.getByLabel('Allow a receiver on this computer or private network')).toHaveCount(0)
    await screen.getByText(`Preview ${destination.name} message · Minimal`).tap()
    const preview = browser.locator(`[aria-label="${destination.name} message sample"]`)
    await expect(preview).toContainText('Needs your input')
    await expect(preview).not.toContainText('Example generated task title')
    await screen.getByLabel('Message content').selectOption({ value: 'standard' })
    await expect(preview).toContainText('Example generated task title')
    await expect(preview).toContainText('Which example option should be used?')
    await screen.getByRole('button', 'Save receiver').tap()
    await expect(screen.getByRole('dialog')).toHaveCount(0)
    await expect(screen.getByText('Save your signing key')).toHaveCount(0)
    const card = screen.getByRole('article').filter({ hasText: `${destination.name} browser fixture` })
    await expect(card.getByText(destination.name)).toBeVisible()
    await card.getByRole('button', `More actions for ${destination.name} browser fixture`).tap()
    await expect(screen.getByRole('menuitem', 'Delete')).toBeVisible()
    await expect(screen.getByRole('menuitem', 'Rotate key')).toHaveCount(0)
    await expect(screen.getByRole('menuitem', 'Revoke old keys')).toHaveCount(0)
    await browser.keyboard.press('Escape')
    await card.getByRole('button', 'Send test').tap()
    await expect(card).toContainText('Last test: passed')
    await card.getByRole('button', 'Activate').tap()
    await expect(screen.getByRole('button', 'Confirm')).toBeDisabled()
    await screen.getByLabel('I understand Standard sends task titles, questions and error text to this receiver.').check()
    await screen.getByRole('button', 'Confirm').tap()
    await expect(card.getByRole('button', 'Pause')).toBeVisible()
    await card.getByRole('button', 'Edit').tap()
    await expect(screen.getByLabel('Destination')).toHaveValue(destination.format)
    await expect(screen.getByLabel('Webhook URL')).toHaveValue('')
    await screen.getByLabel('Name').fill(`${destination.name} renamed fixture`)
    await screen.getByRole('button', 'Review changes').tap()
    await screen.getByRole('button', 'Confirm').tap()
    const renamed = screen.getByRole('article').filter({ hasText: `${destination.name} renamed fixture` })
    await expect(renamed.getByRole('button', 'Pause')).toBeVisible()
    await renamed.getByRole('button', 'Edit').tap()
    await screen.getByLabel('Destination').selectOption({ value: 'cezar.json.v1' })
    await screen.getByLabel('Receiver URL').fill('https://receiver.invalid/converted')
    await screen.getByRole('button', 'Review changes').tap()
    await expect(screen.getByRole('dialog')).toContainText('use Rotate key and copy the new signing key')
    await screen.getByRole('button', 'Confirm').tap()
    await renamed.getByRole('button', `More actions for ${destination.name} renamed fixture`).tap()
    await expect(screen.getByRole('menuitem', 'Rotate key')).toBeVisible()
    await browser.keyboard.press('Escape')
    await expect(renamed.getByRole('button', 'Activate')).toBeVisible()
  })
}

test('custom receiver preserves signing-key setup and rotation', async ({ app, screen }) => {
  await app.open('/p/default/settings/webhooks')
  await screen.getByRole('button', 'Add receiver').tap()
  await expect(screen.getByLabel('Destination')).toHaveValue('cezar.json.v1')
  await screen.getByLabel('Name').fill('Custom browser fixture')
  await screen.getByLabel('Receiver URL').fill('https://receiver.invalid/fictional')
  await screen.getByRole('button', 'Save receiver').tap()
  await expect(screen.getByRole('heading', 'Save your signing key')).toBeVisible()
  // Do not read, log or screenshot the generated signing key.
  await screen.getByRole('button', 'I’ve saved the key').tap()
  const card = screen.getByRole('article').filter({ hasText: 'Custom browser fixture' })
  await card.getByRole('button', 'More actions for Custom browser fixture').tap()
  await expect(screen.getByRole('menuitem', 'Rotate key')).toBeVisible()
  await expect(screen.getByRole('menuitem', 'Revoke old keys')).toBeVisible()
})
