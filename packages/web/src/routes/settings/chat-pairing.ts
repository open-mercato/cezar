import type { ChatInboundStateResponse, ChatSetupBegin, ChatSetupBegun } from '@open-mercato/cezar-api-client'
import type { ChatSetupApi } from '@/lib/chat-providers/types'

// One set of pairing rules for the setup dialog and the inline approval flow, so both behave alike.
const goneCodes = new Set(['pairing_expired', 'expired', 'not_found'])

/** The server no longer holds this setup. Any other poll failure is transient: show it and keep polling. */
export const setupGone = (code: string): boolean => goneCodes.has(code)

/**
 * A receiver-bound begin answers `conflict` when the receiver moved on (a shared bot, a replacement);
 * retry once with its fresh revision. Resolves undefined when `current()` turns false meanwhile.
 */
export async function beginChatSetup(
  api: ChatSetupApi,
  list: (projectId: string) => Promise<Pick<ChatInboundStateResponse, 'receivers'>>,
  projectId: string,
  input: ChatSetupBegin,
  code: (cause: unknown) => string,
  current: () => boolean,
): Promise<ChatSetupBegun | undefined> {
  try {
    return await api.begin(projectId, input)
  } catch (cause) {
    const receiverId = input.receiverId
    if (!receiverId || code(cause) !== 'conflict' || !current()) throw cause
    const fresh = (await list(projectId)).receivers.find(row => row.receiverId === receiverId)?.inboundRevision ?? ''
    if (!current()) return undefined
    return api.begin(projectId, { ...input, expectedRevision: fresh })
  }
}
