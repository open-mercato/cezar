import { it, expect } from 'vitest'
import { createSlackDescriptor, slackDiscoveryCommand } from './index'
import type { ChatProviderDescriptor } from '../types'
it('binds the typed API supplied by the root into the bot descriptor', () => {
 const bindings = { api: {}, setupApi: {}, subscribe: () => () => {} } as unknown as Pick<ChatProviderDescriptor['bot'], 'api' | 'setupApi' | 'subscribe'>
 const descriptor = createSlackDescriptor(bindings)
 expect(descriptor.bot.api).toBe(bindings.api)
 expect(descriptor.bot.begin({ appToken: 'xapp-fixture-token', botToken: 'xoxb-fixture-token' }, 'Slack')).toEqual({ token: '{"appToken":"xapp-fixture-token","botToken":"xoxb-fixture-token"}', name: 'Slack', dedicatedBot: true })
 expect(descriptor.bot.isGroup('group:T1:U1:G1')).toBe(true)
 expect(descriptor.bot.isGroup('private:T1:U1:D1')).toBe(false)
 expect(descriptor.bot.validChatId('C123')).toBe(false)
 expect(slackDiscoveryCommand('https://app.slack.com/client/T1/U1?cezar_start=abc')).toBe('cezar start abc')
})
