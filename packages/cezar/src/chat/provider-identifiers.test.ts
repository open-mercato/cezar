import { describe, expect, it } from 'vitest';
import { chatIdentifierSchemas } from '@open-mercato/cezar-contract';

describe('durable Discord destination identity', () => {
  it.each(['discord:dm:123456789012345678', 'discord:guild:123456789012345678:234567890123456789'])(
    'accepts a qualified destination %s without widening actor identities', chatId => {
      expect(chatIdentifierSchemas.discord.chat.safeParse(chatId).success).toBe(true);
      for (const role of ['bot', 'user', 'message'] as const) {
        expect(chatIdentifierSchemas.discord[role].safeParse(chatId).success).toBe(false);
        expect(chatIdentifierSchemas.discord[role].safeParse('123456789012345678').success).toBe(true);
      }
    },
  );
  it.each(['123456789012345678', 'discord:dm:0', 'discord:guild:123:0', 'discord:dm:123:456', 'discord:guild:123', 'discord:unknown:123'])(
    'rejects ambiguous or malformed destinations %s', chatId => {
      expect(chatIdentifierSchemas.discord.chat.safeParse(chatId).success).toBe(false);
    },
  );
});

describe('durable Slack destination identity', () => {
 it.each(['private:TTEAM:UBOT:DCHAN', 'group:TTEAM:UBOT:CCHAN', 'group:TTEAM:UBOT:GCHAN'])('preserves kind and authenticated namespace in %s', id => {
  expect(chatIdentifierSchemas.slack.chat.safeParse(id).success).toBe(true);
  for (const role of ['user', 'bot', 'message'] as const) expect(chatIdentifierSchemas.slack[role].safeParse(id).success).toBe(false);
 });
 it.each(['DCHAN', 'TTEAM:UBOT:DCHAN', 'private:DCHAN', 'private:TTEAM:UBOT:UNKNOWN'])('rejects ambiguous destinations %s', id => {
  expect(chatIdentifierSchemas.slack.chat.safeParse(id).success).toBe(false);
 });
});

import { randomUUID } from 'node:crypto';
import { freshState, inboundStateSchema, InboundStateStore } from './state.ts';
import { ChatInbox } from './inbox.ts';
import type { ChatEvent } from './provider.ts';
it.each([
 ['slack', 'TTEAM:UBOT', 'private:TTEAM:UBOT:DCHAN', 'UACTOR', '123.000001', 'private'],
 ['slack', 'TTEAM:UBOT', 'group:TTEAM:UBOT:CCHAN', 'UACTOR', '123.000001', 'group'],
 ['discord', '456', 'discord:dm:123', '789', '111', 'private'],
 ['discord', '456', 'discord:guild:222:123', '789', '111', 'group'],
] as const)('pins %s %s destination privacy at receipt persistence and ingress', async (provider, botId, chatId, userId, messageId, kind) => {
 const state = freshState(botId, { projectId: 'p', root: '/p', installationId: 'i', generation: randomUUID() }, provider);
 const correlation = { receiverId: 'r', chatId, messageId, privateChat: kind === 'private', deliveryRevision: 1, bindingGeneration: state.binding.generation, enableGeneration: randomUUID(), runId: 'run', type: 'task.attention_required', sequence: 1, episodeId: 'task-1', continuation: 0, createdAt: 0 };
 expect(inboundStateSchema.safeParse({ ...state, correlations: [correlation] }).success).toBe(true);
 expect(inboundStateSchema.safeParse({ ...state, correlations: [{ ...correlation, privateChat: kind !== 'private' }] }).success).toBe(false);
 const store = new InboundStateStore(state, { assertOwner() {}, async write() {} });
 let processed = 0;
 const inbox = new ChatInbox(store, async () => { processed++; });
 const event: ChatEvent = { kind: 'message', id: 'envelope-1', chat: { id: chatId, kind: kind === 'private' ? 'group' : 'private' }, user: { id: userId, label: 'Actor' }, messageId, at: 0, text: 'hello', addressed: true };
 await expect(inbox.accept(event)).rejects.toThrow('identity');
 expect(processed).toBe(0); expect(store.snapshot().receivedEvents).toEqual([]);
 if (provider === 'slack') {
  expect(inboundStateSchema.safeParse({ ...state, botId: 'TTEAM:UOTHER', correlations: [correlation] }).success).toBe(false);
  await expect(inbox.accept({ ...event, chat: { id: chatId.replace('UBOT', 'UOTHER'), kind } })).rejects.toThrow('identity');
 }
});
