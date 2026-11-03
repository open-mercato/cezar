import { randomUUID } from 'node:crypto';
import type { TelegramUpdate } from './protocol.ts';
import { forgetReplies, type InboundStateStore } from './state.ts';

/** Service messages have no text. Never transfer grants to a migrated chat. */
export async function processGroupEvent(store: InboundStateStore, update: TelegramUpdate, epoch: string): Promise<boolean> {
  const member = update.my_chat_member, message = update.message;
  const migration = message?.migrate_to_chat_id !== undefined || message?.migrate_from_chat_id !== undefined;
  if (!member && !migration) return false;
  const affected = new Set<string>();
  if (migration && message) {
    affected.add(String(message.chat.id));
    if (message.migrate_from_chat_id !== undefined) affected.add(String(message.migrate_from_chat_id));
  }
  if (member && (['left', 'kicked'].includes(member.new_chat_member.status) || member.chat.is_forum)) affected.add(String(member.chat.id));
  await store.change(state => {
    if (epoch !== state.epoch || (state.nextOffset !== null && update.update_id < state.nextOffset)) return;
    let changed = false;
    for (const receiver of state.receivers) if (affected.has(receiver.chatId)) {
      receiver.enabled = false; receiver.generation = randomUUID(); receiver.suspendedReason = migration ? 'group_migrated' : 'bot_removed'; changed = true;
    }
    if (changed) {
      forgetReplies(state, row => affected.has(row.chatId));
      state.configGeneration = randomUUID();
    }
    state.nextOffset = update.update_id + 1; state.phase = 'active';
  });
  return true;
}
