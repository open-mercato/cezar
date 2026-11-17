import { randomUUID } from 'node:crypto';
import type { InputUpdate } from './events.ts';
import { forgetReplies, type InboundStateStore } from './state.ts';

/** Service messages have no text. Never transfer grants to a migrated chat. */
export async function processGroupEvent(store: InboundStateStore, update: InputUpdate, epoch: string): Promise<boolean> {
  if (!update.membership) return false;
  const affected = new Set(update.membership.affected);
  await store.change(state => {
    if (epoch !== state.epoch || (state.nextOffset !== null && update.sequence < state.nextOffset)) return;
    let changed = false;
    for (const receiver of state.receivers) if (affected.has(receiver.chatId)) {
      receiver.enabled = false; receiver.generation = randomUUID(); receiver.suspendedReason = update.membership!.reason; changed = true;
    }
    if (changed) {
      forgetReplies(state, row => affected.has(row.chatId));
      state.configGeneration = randomUUID();
    }
    state.nextOffset = update.sequence + 1; state.phase = 'active';
  });
  return true;
}
