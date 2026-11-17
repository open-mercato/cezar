import type { telegramApi } from '@/api/client'
import type { ChatSetupActivate, ChatSetupActivated, ChatSetupBegin, ChatSetupBegun, ChatSetupStatus } from '@open-mercato/cezar-api-client'
import type { LucideIcon } from 'lucide-react'
export type ChatSetupApi = {
 begin: (projectId: string, input: ChatSetupBegin) => Promise<ChatSetupBegun>
 status: (projectId: string, id: string, signal?: AbortSignal) => Promise<ChatSetupStatus>
 activate: (projectId: string, id: string, input: Omit<ChatSetupActivate, 'activate'>) => Promise<ChatSetupActivated>
 /** An abandoned setup must free its pairing slot (three pending sessions is the server limit). */
 cancel: (projectId: string, id: string) => Promise<unknown>
}
export interface ChatCredentialField {
 name: string; label: string; placeholder: string; pattern: RegExp; invalid: string; hint?: string; visibleWhen?: (credentials: Readonly<Record<string, string>>) => boolean
 /** Mirror the extension SDK's credential flags: an empty optional field is valid; `secret: false` is shown as text. */
 optional?: boolean; secret?: boolean
}
export interface ChatProviderDescriptor {
 id: string; name: string; format: string; icon: LucideIcon; description: string
 /** Notifications can also run without a bot, through an incoming-webhook receiver of `format`;
  *  `instructions` say where its URL comes from. Absent: every receiver is a bot chat. */
 webhookNotifications?: { instructions: string }
 /** Connect opens the bot wizard directly, which offers task control as its own later step. */
 directSetup?: boolean
 bot: {
  api: typeof telegramApi; setupApi: ChatSetupApi
  subscribe(changed: () => void): () => void
  validChatId(id: string | undefined): boolean; isGroup(id: string | undefined): boolean
  fields: readonly ChatCredentialField[]
  /** Trusted operator guidance; raw server errors are never displayed. */
  setupErrorMessages: Readonly<Record<string, string>>
  settingsErrorMessages: Readonly<Record<string, string>>
  approval: {
   savedCredentials: string; checkingCredentials: string; waitingTitle: string
   waiting(username: string, group: boolean): string; candidate(username: string): string
   controlDescription: string; privateControl: string; groupControl: string; controlHint: string; comparisonHint: string
   /** The control step's private link label. Default: `privateLabel`. */
   privateLink?: string
  }
  unavailableMessages: Readonly<Record<string, string>>
  /** `create` names where credentials come from when no setup help lists the creation steps. */
  credentialHelp: { create?: string; add: string; storage: string }
  /** Credentials that can expire in place (rotating tokens): their chats offer a repair with this hint. */
  credentialRepair?: string
  /** Actionable command syntax and addressing instructions for shared task-control UI. */
  commands: { respond: string; reply: string; cancel: string; continue: string; guidance: string }
  groupRestriction: string
  /** Names `lastSuccessfulPollAt` in bot health: Telegram polls, socket providers connect. Default "Last connected". */
  lastContactLabel?: string
  credentialHint: string; help: { label: string; href: string }
  discoveryHint: string; privateHint: string; groupHint: string
  /** Link labels for the connect step; Discord lists its server invitation before the private chat. */
  privateLabel?: string; groupLabel?: string; groupFirst?: boolean
  /** Platforms without a start-payload link require a visible command to paste. */
  discoveryCommand?(link: string, group?: boolean): string | undefined
  groupLink(link: string): string | undefined
  begin(credentials: Readonly<Record<string, string>>, name: string): ChatSetupBegin
 }
}
