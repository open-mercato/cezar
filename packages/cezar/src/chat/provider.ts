import { chatProviderIdSchema as providerId, chatOpaqueIdSchema } from '@open-mercato/cezar-contract';
import { z } from 'zod';

/** Internal boundary. Opaque platform identifiers are never interpreted by orchestration. */
export const chatProviderIdSchema = providerId;
export type ChatProviderId = z.infer<typeof chatProviderIdSchema>;
export { chatIdSchema, chatRefSchema, chatReceiptSchema, chatButtonSchema, chatMessageSchema, chatIdentitySchema, chatCredentialsSchema, chatFailureSchema, chatEventSchema } from '@open-mercato/cezar-contract';
import type { ChatRef, ChatReceipt, ChatMessage, ChatIdentity, ChatCredentials, ChatFailure } from '@open-mercato/cezar-contract';
export type { ChatRef, ChatReceipt, ChatMessage, ChatIdentity, ChatCredentials, ChatFailure, ChatEvent } from '@open-mercato/cezar-contract';
export class ChatTransportError extends Error {
  constructor(readonly failure: ChatFailure) { super(`Chat transport: ${failure.kind}`); }
}
export interface ChatSession {
  identify(signal?: AbortSignal): Promise<ChatIdentity>;
  send(chatId: string, message: ChatMessage, signal?: AbortSignal, valid?: () => boolean): Promise<ChatReceipt>;
  clearButtons(receipt: ChatReceipt, signal?: AbortSignal): Promise<void>;
  acknowledge(eventId: string, text: string, signal?: AbortSignal): Promise<void>;
  isMember(chatId: string, userId: string, signal?: AbortSignal): Promise<boolean | undefined>;
}
/** Rendering is provider-owned; no wire markup or callback fields cross this boundary. */
export interface ChatProvider {
  readonly id: ChatProviderId;
  readonly label: string;
  readonly credentials: readonly { name: string; label: string; pattern?: RegExp }[];
  readonly limits: { maxText: number; buttonsPerMessage: number; perChatPerSecond: number; perBotPerSecond: number };
  readonly ids: { bot: z.ZodType<string>; chat: z.ZodType<string>; user: z.ZodType<string>; message: z.ZodType<string> };
  renderText(text: string, max?: number, username?: string): string;
  command(name: string, username?: string): string;
  discoveryLink(username: string, code: string): string;
}
export interface ChatTransport extends ChatSession {
 /** The guard is rechecked at the last asynchronous preparation boundary before every wire call. */
 guarded(valid: () => boolean): ChatTransport;
 inspect(chatId: string): Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }>;
 connect(journal: import('./connection.ts').ReceiveJournal, options: import('./connection.ts').ChatConnectionOptions, now?: () => number): import('./connection.ts').ChatConnection;
}
export interface ChatServiceDescriptor {
 /** Explicit pairing templates take precedence over a dynamic identity discovery URL. */
 pairingUsesIdentityUrl?: boolean;
 credentials: ChatProvider['credentials'];
 id: ChatProviderId; label: string; format: string;
 ids: ChatProvider['ids']; presentation: import('./presentation.ts').ChatPresentation;
 limits: ChatProvider['limits'];
 /** Local credential encoding only; these functions never perform I/O. */
 destination(credential: string): string;
 credentialBotId(destination: string | undefined): string | undefined;
 /** Native providers: the stored credential as the shipped adapter's fields, and the escaped format the host renders for it. */
 adapterCredential?(stored: string): string;
 textFormat?: 'telegram-html' | 'slack-mrkdwn';
}
