import { webhookFormatSchema } from '@open-mercato/cezar-contract';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { RunRecord } from '../runs/store.ts';
import { runLifecycleSnapshot } from '../runs/lifecycle.ts';
import type { Correlation, InboundGrant, InboundState } from './state.ts';
import { freshMessage } from './events.ts';
import { z } from 'zod';


export function receiverEligible(receiver: PrivateReceiver | undefined): receiver is PrivateReceiver {
  // Outbound 'suspended' means transient send failures only; it must not silently stop inbound polling.
  return receiver !== undefined && receiver.format !== 'cezar.json.v1' && webhookFormatSchema.safeParse(receiver.format).success && (receiver.state === 'active' || receiver.state === 'suspended') && receiver.lastTest === 'success'
    && receiver.profile === 'standard' && (receiver.preset === 'attention' || receiver.preset === 'all' || receiver.events.includes('task.attention_required')) && receiver.chatSecret !== undefined;
}
/** The live receiver still agrees with every inbound identity field of its persisted binding. */
export function bindingCurrent(binding: InboundState['receivers'][number] | undefined, receiver: PrivateReceiver | undefined): receiver is PrivateReceiver {
  return !!binding && receiverEligible(receiver) && receiver.chatId === binding.chatId
    && receiver.deliveryRevision === binding.deliveryRevision && receiver.chatSecret!.sha256 === binding.credentialFingerprint;
}
export function authorize(state: InboundState, chatId: string, userId: string, receiver: (id: string) => PrivateReceiver | undefined): InboundGrant | undefined {
  const binding = state.receivers.find(binding => binding.chatId === chatId && binding.enabled);
  if (!binding || receiver(binding.receiverId)?.format !== `${state.provider}.v1` || !bindingCurrent(binding, receiver(binding.receiverId))) return undefined;
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

/**
 * A group grant is only as current as the person's membership: someone who left or was
 * removed must not keep controlling tasks from that group. Answers are cached briefly.
 */
export class GroupMembership {
  private readonly cache = new Map<string, { member: boolean; until: number }>();
  constructor(private readonly check: (chatId: string, userId: string) => Promise<boolean | undefined>, private readonly now: () => number = Date.now, private readonly ttlMs = 60_000, private readonly max = 1000) {}
  /** True for a member, false for someone gone, undefined when the platform could not say. */
  async member(chatId: string, userId: string): Promise<boolean | undefined> {
    const key = JSON.stringify([chatId, userId]), now = this.now(), cached = this.cache.get(key);
    if (cached && cached.until > now) return cached.member;
    const member = await this.check(chatId, userId).catch(() => undefined);
    if (member === undefined) return undefined;
    for (const [entry, row] of this.cache) if (row.until <= now) this.cache.delete(entry);
    if (this.cache.size < this.max) this.cache.set(key, { member, until: now + this.ttlMs });
    return member;
  }
}
