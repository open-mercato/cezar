import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ChatMessage } from './provider.ts';
import { ChatReplies } from './dispatcher.ts';
import { freshState, inboundStateSchema } from './state.ts';
import { classifyChatMessage } from './message-router.ts';
import { chatSourceRecordSchema, chatSourceProvenanceSchema } from '@open-mercato/cezar-contract';
it('passes an explicit same-chat original receipt through the shared dispatcher', async () => {
 const send = vi.fn(async (_chat: string, _message: ChatMessage) => ({ chatId: '456', messageId: '22' }));
 const replies = new ChatReplies({ send });
 try {
  expect(replies.deliver('456', 'answer', { valid: () => true, replyTo: { chatId: '456', messageId: '11' } })).toBe(true);
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0]?.[1]).toMatchObject({ text: 'answer', replyTo: { chatId: '456', messageId: '11' } });
  expect(replies.deliver('456', 'wrong chat', { valid: () => true, replyTo: { chatId: '789', messageId: '11' } })).toBe(false);
 } finally { await replies.stop(); }
});
it('preserves the original receipt across restart and routes the newest thread notice without crossing chats', () => {
 const state = freshState('123', { projectId: 'p', root: '/p', installationId: 'i', generation: randomUUID() });
 const generation = randomUUID();
 state.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
 const row = { receiverId: 'receiver', chatId: '456', messageId: '22', replyTo: { chatId: '456', messageId: '11' }, privateChat: true,
  deliveryRevision: 1, bindingGeneration: state.binding.generation, enableGeneration: generation, runId: 'run', type: 'task.attention_required', sequence: 1, episodeId: 'task-1', continuation: 0, createdAt: 1 };
 state.correlations.push(row, { ...row, messageId: '33', createdAt: 2, sequence: 2, episodeId: 'task-2' });
 const restarted = inboundStateSchema.parse(JSON.parse(JSON.stringify(state)));
 const update = { sequence: 1, message: { id: '44', at: 3, chat: { id: '456', kind: 'private' as const }, user: { id: '456', label: 'Person' }, text: 'answer', addressed: false, command: { kind: 'text' as const }, replyTo: '11' } };
 const route = classifyChatMessage(update, { botUsername: 'bot', chatId: '456', userId: '456', receiverId: 'receiver', state: restarted, runs: [], episode: () => 'task-2' });
 expect(route).toMatchObject({ kind: 'explicit-reply', correlation: { messageId: '33', episodeId: 'task-2' } });
 expect(inboundStateSchema.safeParse({ ...state, correlations: [{ ...row, replyTo: { chatId: '789', messageId: '11' } }] }).success).toBe(false);
});
it('keeps a source thread receipt private and validates its destination', () => {
 const source = { id: randomUUID(), provider: 'telegram', botId: '123', epoch: randomUUID(), projectId: 'p', receiverId: 'r', grantId: randomUUID(), grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: '456', userId: '456', sourceMessageId: '44', replyTo: { chatId: '456', messageId: '11' }, updateId: 1, episodeId: 'task-1', requestId: randomUUID(), state: 'claimed', createdAt: 0, updatedAt: 0 };
 expect(chatSourceRecordSchema.parse(source).replyTo).toEqual(source.replyTo);
 expect(chatSourceProvenanceSchema.shape).not.toHaveProperty('replyTo');
 expect(chatSourceRecordSchema.safeParse({ ...source, replyTo: { chatId: '789', messageId: '11' } }).success).toBe(false);
});

import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { ChatBotRuntime } from './runtime.ts';
import { BotLease } from './ownership.ts';
import { InboundStateStore } from './state.ts';
import { Pairings } from './pairing.ts';
import { telegramPresentation } from './providers/telegram/presentation.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
it('delivers a persisted source outcome to its original bot receipt and persists that thread for later replies', async () => {
 const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
 const binding = await lease.bind({ projectId: 'p', installationId: 'i', root: '/p' });
 const initial = freshState(botId, binding), generation = randomUUID(), grantId = randomUUID();
 initial.receivers.push({ receiverId: 'r', chatId: '456', enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
 const grant = { id: grantId, receiverId: 'r', chatId: '456', userId: '456', label: 'Actor', permissions: ['respond', 'start'] as Array<'respond' | 'start'>, capability: 'task_control' as const, generation: randomUUID(), enableGeneration: generation, approvedAt: 0 };
 initial.grants.push(grant);
 initial.sources.push({ id: randomUUID(), provider: 'telegram', botId, epoch: initial.epoch, projectId: 'p', receiverId: 'r', grantId, grantGeneration: grant.generation, enableGeneration: generation, chatId: '456', userId: '456', sourceMessageId: '44', replyTo: { chatId: '456', messageId: '11' }, updateId: 1, episodeId: 'task-1', requestId: randomUUID(), state: 'policy_refused', policyReason: 'account_unavailable', createdAt: Date.now(), updatedAt: Date.now() });
 const state = new InboundStateStore(inboundStateSchema.parse(JSON.parse(JSON.stringify(initial))), { assertOwner: () => lease.assertOwner(), async write() {} });
 const receiver = { id: 'r', format: 'telegram.v1', chatId: '456', state: 'active', lastTest: 'success', profile: 'standard', preset: 'attention', events: [], deliveryRevision: 1, chatSecret: { sha256: 'a'.repeat(64) } } as unknown as PrivateReceiver;
 const events = new EventEmitter();
 const project = { root: '/p', store: { on: events.on.bind(events), off: events.off.bind(events), listRuns: () => [], getRun: () => undefined } } as unknown as ProjectContext;
 const send = vi.fn(async (_id: string, _message: ChatMessage) => ({ chatId: '456', messageId: '55' }));
 const runtime = new ChatBotRuntime({ botId, state, lease, pairings: new Pairings(telegramPresentation), presentation: telegramPresentation, session: { identify: async () => ({ id: botId, username: 'bot' }), send, clearButtons: async () => {}, acknowledge: async () => {}, isMember: async () => true },
  receiver: () => receiver, receivers: () => [receiver], context: async () => project, deliver: vi.fn(), episode: () => undefined, assertCredentials: async () => {}, changed() {},
  connect: () => ({ start() {}, async stop() {}, health: () => ({ state: 'polling' }) }),
 });
 try {
  await runtime.start(); await vi.waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0]?.[1].replyTo).toEqual({ chatId: '456', messageId: '11' });
  await vi.waitFor(() => expect(state.snapshot().correlations[0]).toMatchObject({ messageId: '55', replyTo: { chatId: '456', messageId: '11' } }));
 } finally { await runtime.stop(); await lease.release(); }
});
