import { discordServiceDescriptor } from './providers/discord/index.ts'
import { slackServiceDescriptor } from './providers/slack/index.ts'
import { telegramServiceDescriptor } from './providers/telegram/index.ts'
import type { ChatServiceDescriptor } from './provider.ts'

/** Native IDs, formats and presentation stay stable across implementation selection. */
export const bundledChatProviders: readonly ChatServiceDescriptor[] = [
  telegramServiceDescriptor,
  slackServiceDescriptor,
  discordServiceDescriptor,
]

export function bundledChatProvider(id: string): ChatServiceDescriptor | undefined {
  return bundledChatProviders.find(provider => provider.id === id)
}

/** External declarations cannot claim native identities without verified host adoption. */
export function validateBundledProviderCollision(id: string, format: string): void {
  if (bundledChatProviders.some(provider => provider.id === id || provider.format === format)) {
    throw new Error(`chat provider id or format is reserved by a bundled provider: ${id} (${format})`)
  }
}
