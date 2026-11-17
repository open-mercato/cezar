import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
test('one guided wizard configures a fresh private Telegram receiver and task control using simulated Telegram', async ({ app, screen }) => {
  await app.open('/p/default/settings/integrations?integration=telegram')
  await expect(screen.getByRole('button', /^(Connect Telegram|Add a chat)$/)).toBeVisible()
  // Token-led private setup: setup begin returns a deep link, then the fixture's
  // simulated /start is observed by status polling before activation.
  await screen.getByRole('button', /^(Connect Telegram|Add a chat)$/).tap()
  await screen.getByLabel('Bot token').fill(`123456:${'x'.repeat(35)}`)
  await screen.getByRole('checkbox', 'This bot is dedicated to this project').check()
  await screen.getByRole('button', 'Continue').tap()
  // The simulated person presses Start at once, so the wizard already shows the sender instead of the links.
  await expect(screen.getByText(/Connected as/)).toBeVisible()
  await screen.getByRole('checkbox', /Enable task control for this private chat/).check()
  // /task needs the opt-in Start tasks permission.
  await screen.getByRole('checkbox', 'Start tasks').check()
  await screen.getByRole('button', 'Activate notifications and task control').tap()
  await expect(screen.getByText(/task control is enabled/)).toBeVisible()
  await screen.getByRole('button', 'Done').tap()

  if (!app.baseUrl) throw new Error('Expected the disposable Telegram fixture server URL')
  const base = app.baseUrl.replace(/\/$/, '')
  let telegramRunId = ''
  await expect.poll(async () => {
    const response = await fetch(`${base}/api/v1/runs`)
    const runs = await response.json() as Array<{ id: string; task?: string; status?: string }>
    const run = runs.find(row => row.task?.includes('deterministic Telegram fixture'))
    telegramRunId = run?.id ?? ''
    return run?.status ?? ''
  }).toBe('done')
  const allRuns = await fetch(`${base}/api/v1/runs`).then(response => response.json()) as Array<{ task?: string }>
  expect(allRuns.filter(row => row.task?.includes('deterministic Telegram fixture'))).toHaveLength(1)
  expect(allRuns.some(row => row.task?.includes('Bare text must never start'))).toBe(false)
  const telegramRun = await fetch(`${base}/api/v1/runs/${telegramRunId}`).then(response => response.json()) as { chatSource?: { id?: string; state?: string; chatId?: string; userId?: string; botId?: string } }
  expect(telegramRun.chatSource?.id).toEqual(expect.any(String))
  expect(telegramRun.chatSource?.state).toBeUndefined()
  expect(telegramRun.chatSource?.chatId).toBeUndefined()
  expect(telegramRun.chatSource?.userId).toBeUndefined()
  expect(telegramRun.chatSource?.botId).toBeUndefined()

})
