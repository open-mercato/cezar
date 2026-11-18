import { telegramDescriptor } from './telegram'
import { createSlackDescriptor } from './slack'
import { createDiscordDescriptor } from './discord'
import { slackApi, discordApi } from '@/api/client'
import { subscribeTopic } from '@/api/ws'
import { chatInboundInvalidationSchema } from '@open-mercato/cezar-api-client'
import type { ChatProviderDescriptor } from './types'
export type { ChatProviderDescriptor } from './types'
const subscribe = (topic: string) => (changed: () => void) => subscribeTopic(topic, data => {
 if (chatInboundInvalidationSchema.safeParse(data).success) changed()
})
export const chatProviderDescriptors: readonly ChatProviderDescriptor[] = [
 createSlackDescriptor({ api: slackApi, setupApi: slackApi.setup, subscribe: subscribe('slack-inbound') }),
 createDiscordDescriptor({ api: discordApi, setupApi: discordApi.setup, subscribe: subscribe('discord-inbound') }),
 telegramDescriptor,
]
