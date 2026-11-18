import { expect, it } from 'vitest'
import { reasonLabel } from './webhook-presentation'

it('fixes an unavailable Telegram token with Add a chat, which keeps the chat and its approvals', () => {
  expect(reasonLabel('telegram_token_unavailable')).toBe('Telegram token unavailable — use Add a chat with the bot’s current token')
  expect(reasonLabel('telegram_token_unavailable')).not.toMatch(/remove/i)
})
