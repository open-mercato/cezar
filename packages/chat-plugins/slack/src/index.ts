import { defineExtension } from '@open-mercato/cezar-extension-sdk'
import { createSlackAdapter } from './adapter.js'

export { createSlackAdapter, slackRequest } from './adapter.js'

export default defineExtension({
  activate(context) {
    return context.chat.register('slack', (credentials, services) => createSlackAdapter(credentials, undefined, {}, services))
  },
})
