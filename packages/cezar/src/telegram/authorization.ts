import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { RunRecord } from '../runs/store.ts';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import type { Correlation, InboundGrant, InboundState } from './state.ts';
import { freshMessage } from './protocol.ts';
import { z } from 'zod';
import { TelegramApiError, type TelegramCall } from './client.ts';

export function receiverEligible(receiver: PrivateReceiver | undefined): receiver is PrivateReceiver {
  // Outbound 'suspended' means transient send failures only; it must not silently stop inbound polling.
  return receiver?.format === 'telegram.v1' && (receiver.state === 'active' || receiver.state === 'suspended') && receiver.lastTest === 'success'
    && receiver.profile === 'standard' && (receiver.preset === 'attention' || receiver.preset === 'all' || receiver.events.includes('task.attention_required')) && receiver.telegramSecret !== undefined;
}
/** The live receiver still agrees with every inbound identity field of its persisted binding. */
export function bindingCurrent(binding: InboundState['receivers'][number] | undefined, receiver: PrivateReceiver | undefined): receiver is PrivateReceiver {
  return !!binding && receiverEligible(receiver) && receiver.telegramChatId === binding.chatId
    && receiver.deliveryRevision === binding.deliveryRevision && receiver.telegramSecret!.sha256 === binding.credentialFingerprint;
}
export function authorize(state: InboundState, chatId: string, userId: string, receiver: (id: string) => PrivateReceiver | undefined): InboundGrant | undefined {
  const binding = state.receivers.find(binding => binding.chatId === chatId && binding.enabled);
  if (!binding || !bindingCurrent(binding, receiver(binding.receiverId))) return undefined;
  return state.grants.find(grant => grant.receiverId === binding.receiverId && grant.chatId === chatId && grant.userId === userId
    && grant.enableGeneration === binding.generation && grant.permissions.includes('respond'));
}
export function grantFresh(state: InboundState, grant: InboundGrant, messageDate: number, now: number): boolean {
  const binding = state.receivers.find(binding => binding.receiverId === grant.receiverId);
  return !!binding && freshMessage(messageDate, Math.max(binding.acceptAfter, grant.approvedAt), now);
}
export function correlationCurrent(state: InboundState, correlation: Correlation, run: RunRecord, episodeId: string | undefined): boolean {
  const binding = state.receivers.find(binding => binding.receiverId === correlation.receiverId);
  return !!binding && binding.enabled && binding.generation === correlation.enableGeneration
    && state.binding.generation === correlation.bindingGeneration && binding.deliveryRevision === correlation.deliveryRevision
    && run.id === correlation.runId && !run.archived && run.status === 'waiting'
    && correlation.type === 'task.attention_required' && episodeId !== undefined && episodeId === correlation.episodeId
    && runLifecycleSnapshot(run).continuation === correlation.continuation
    && (correlation.requestId === undefined || (run.attentionRequest?.requestId === correlation.requestId && run.attentionRequest.askedAt === correlation.askedAt));
}
/** `respond` is the base every grant carries; the others are separate opt-ins. */
export const grantAllows = (grant: Pick<InboundGrant, 'permissions'>, permission: InboundGrant['permissions'][number]): boolean =>
  grant.permissions.includes('respond') && grant.permissions.includes(permission);

const chatMemberSchema = z.object({ user: z.object({ id: z.number().int().positive().safe() }),
  status: z.enum(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked']), is_member: z.boolean().optional() });
/**
 * A group grant is only as current as the person's membership: someone who left or was
 * removed must not keep controlling tasks from that group. Answers are cached briefly.
 */
export class GroupMembership {
  private readonly cache = new Map<string, { member: boolean; until: number }>();
  constructor(private readonly call: TelegramCall, private readonly now: () => number = Date.now, private readonly ttlMs = 60_000, private readonly max = 1000) {}
  /** True for a member, false for someone gone, undefined when Telegram could not say. */
  async member(chatId: string, userId: string): Promise<boolean | undefined> {
    if (!chatId.startsWith('-')) return true;
    const key = `${chatId}:${userId}`, now = this.now(), cached = this.cache.get(key);
    if (cached && cached.until > now) return cached.member;
    let member: boolean;
    try {
      const parsed = chatMemberSchema.safeParse(await this.call('getChatMember', { chat_id: Number(chatId), user_id: Number(userId) }));
      if (!parsed.success || parsed.data.user.id !== Number(userId)) return undefined;
      member = !['left', 'kicked'].includes(parsed.data.status) && (parsed.data.status !== 'restricted' || parsed.data.is_member === true);
    } catch (error) {
      // Telegram answers 400 for someone who is not in the chat at all; anything else is unknown.
      if (error instanceof TelegramApiError && error.code === 'http' && error.status === 400) member = false;
      else return undefined;
    }
    for (const [entry, row] of this.cache) if (row.until <= now) this.cache.delete(entry);
    if (this.cache.size < this.max) this.cache.set(key, { member, until: now + this.ttlMs });
    return member;
  }
}
