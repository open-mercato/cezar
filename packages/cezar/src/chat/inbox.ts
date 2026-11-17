import { qualifiedChatKind, chatDestinationMatchesBot, chatIdentifierSchemaFor } from '@open-mercato/cezar-contract';
import { chatSessionEventSchema, type ChatSessionEvent } from '@open-mercato/cezar-contract';
import { isChatCommand, type InputUpdate, type InputMessage } from './events.ts';
import type { Correlation, InboundStateStore } from './state.ts';
/** Socket/gateway providers use opaque event IDs. Sequencing and crash deduplication belong to the core. */
export class ChatInbox {
 private tail: Promise<void> = Promise.resolve();
 constructor(private readonly state: InboundStateStore, private readonly process: (update: InputUpdate, epoch: string) => Promise<void>) {}
 accept(raw: ChatSessionEvent): Promise<void> {
  const event = chatSessionEventSchema.parse(raw);
  const work = this.tail.then(async () => {
   const snapshot = this.state.snapshot(), ids = chatIdentifierSchemaFor(snapshot.provider);
   const kind = qualifiedChatKind(snapshot.provider, event.chat.id);
   if (!chatDestinationMatchesBot(snapshot.provider, event.chat.id, snapshot.botId) || (kind !== undefined && event.chat.kind !== kind)
     || ('user' in event && !ids.user.safeParse(event.user.id).success)
     || (event.kind === 'message' && (!ids.message.safeParse(event.messageId).success || (event.replyTo && !ids.message.safeParse(event.replyTo.messageId).success)))
     || (event.kind === 'button' && !ids.message.safeParse(event.receipt.messageId).success)
     || (event.kind === 'membership' && event.affectedChatIds?.some(id => !chatDestinationMatchesBot(snapshot.provider, id, snapshot.botId)))
     || (event.kind === 'membership' && event.previousChatId && !chatDestinationMatchesBot(snapshot.provider, event.previousChatId, snapshot.botId))) throw new Error('Invalid provider event identity');
   const existing = snapshot.receivedEvents.find(row => row.id === event.id);
   if (existing) return; // A received claim is never replayed into an unaudited second effect.
   const sequence = Math.max(snapshot.nextOffset ?? 0, ...snapshot.receivedEvents.map(row => row.sequence + 1));
   const update = normalizeChatEvent(event, sequence);
   // Group chatter nothing would act on costs no durable claim; commands stay claimed for pairing.
   if (update.message && update.message.command.kind !== 'command' && groupIgnores(update.message, snapshot.correlations)) return;
   await this.state.change(state => {
    state.receivedEvents.push({ id: event.id, sequence });
    state.receivedEvents = state.receivedEvents.slice(-1000);
   });
   await this.process(update, snapshot.epoch);
   await this.state.flush();
  });
  this.tail = work.catch(() => undefined); return work;
 }
 drain(): Promise<void> { return this.tail; }
}
/** A group hears only commands addressed to this bot and Replies to one of its own notices. */
export function groupIgnores(message: InputMessage, correlations: readonly Pick<Correlation, 'chatId' | 'messageId' | 'replyTo'>[]): boolean {
 if (message.chat.kind === 'private') return false;
 const chatId = String(message.chat.id), replyTo = message.replyTo;
 const correlated = replyTo !== undefined && correlations.some(row => row.chatId === chatId && (row.messageId === replyTo || row.replyTo?.messageId === replyTo));
 return message.command.kind !== 'text' ? !message.addressed : !correlated;
}
export function normalizeChatEvent(event: ChatSessionEvent, sequence: number): InputUpdate {
 if (event.kind === 'membership') return { sequence, membership: { affected: event.affectedChatIds ?? [event.chat.id, ...(event.previousChatId ? [event.previousChatId] : [])], reason: event.reason === 'removed' ? 'bot_removed' : 'group_migrated' } };
 if (event.kind === 'button') return { sequence, button: { id: event.id, userId: event.user.id, chatId: event.chat.id, messageId: event.receipt.messageId, data: event.data } };
 const text = event.kind === 'start' ? `/start ${event.code}` : event.text;
 const match = /^\/([a-zA-Z0-9_]{1,32})(?:\s+([\s\S]*))?$/.exec(text);
 const command: InputMessage['command'] = match && (isChatCommand(match[1]!.toLowerCase()) || match[1] === 'start')
  ? { kind: 'command', name: match[1]!.toLowerCase(), args: match[2]?.trim() ?? '' }
  : { kind: text.startsWith('/') ? 'unknown' : 'text' };
 return { sequence, message: { id: event.kind === 'start' ? event.id : event.messageId, at: event.at,
  chat: { ...event.chat, ...(event.title ? { title: event.title } : {}) }, user: event.user,
  text, addressed: event.kind === 'start' || event.addressed, command: event.kind === 'message' && event.command ? event.command : command,
  ...(event.kind === 'message' && event.pairingEligible !== undefined ? { pairingEligible: event.pairingEligible } : {}),
  ...(event.kind === 'message' && event.replyTo ? { replyTo: event.replyTo.messageId } : {}) } };
}
