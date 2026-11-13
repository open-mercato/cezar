import { defineExtension } from '@open-mercato/cezar-extension-sdk'
import { createTelegramAdapter, telegramRequest } from './adapter.js'

export { createTelegramAdapter, telegramRequest } from './adapter.js'

export default defineExtension({
  activate(context) {
    return context.chat.register('telegram', credentials => createTelegramAdapter(telegramRequest(credentials.token ?? '')))
  },
})
