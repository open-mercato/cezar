import { telegramDescriptor } from './telegram'
import type { ChatProviderDescriptor } from './types'
export type { ChatProviderDescriptor } from './types'
export const chatProviderDescriptors: readonly ChatProviderDescriptor[] = [
 telegramDescriptor,
]
