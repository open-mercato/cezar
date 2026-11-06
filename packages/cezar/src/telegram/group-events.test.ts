import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { freshState, InboundStateStore } from './state.ts';
import { processGroupEvent } from './group-events.ts';
it.each(['migration', 'removal'] as const)('%s suspends only the affected group and persists the update offset in the same write', async kind => {
  const initial = freshState('123', { projectId: 'project', root: '/repo', installationId: 'install', generation: randomUUID() });
  for (const chatId of ['-123', '-456']) initial.receivers.push({ receiverId: chatId, chatId, enabled: true, generation: randomUUID(), deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64), acceptAfter: 0 });
  let writes = 0;
  const state = new InboundStateStore(initial, { assertOwner() {}, async write() { writes++; } });
  const update = kind === 'migration' ? { update_id: 5, message: { message_id: 1, date: 10, chat: { id: -123, type: 'group' as const }, migrate_to_chat_id: -100123 } }
    : { update_id: 5, my_chat_member: { chat: { id: -123, type: 'group' as const }, new_chat_member: { status: 'left' } } };
  expect(await processGroupEvent(state, update, initial.epoch)).toBe(true);
  expect(state.snapshot().receivers[0]).toMatchObject({ enabled: false, chatId: '-123' });
  expect(state.snapshot().receivers[0]!.generation).not.toBe(initial.receivers[0]!.generation);
  expect(state.snapshot().receivers[1]).toEqual(initial.receivers[1]);
  expect(state.snapshot().nextOffset).toBe(6); expect(writes).toBe(1);
});
it('a private chat that blocked the bot keeps its delivery receipts and loses its question routes', async () => {
  const initial = freshState('123', { projectId: 'project', root: '/repo', installationId: 'install', generation: randomUUID() });
  const generation = randomUUID();
  initial.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64), acceptAfter: 0 });
  const row = (type: string, messageId: number) => ({ receiverId: 'receiver', chatId: '456', messageId, deliveryRevision: 1, bindingGeneration: initial.binding.generation,
    enableGeneration: generation, runId: 'run', type, sequence: 1, episodeId: 'run-1', continuation: 0, createdAt: Date.now() });
  initial.correlations.push(row('source-final:source', 1), row('task.finished', 2), row('task.attention_required', 3));
  const state = new InboundStateStore(initial, { assertOwner() {}, async write() {} });
  const update = { update_id: 5, my_chat_member: { chat: { id: 456, type: 'private' as const }, new_chat_member: { status: 'kicked' } } };
  expect(await processGroupEvent(state, update, initial.epoch)).toBe(true);
  expect(state.snapshot().receivers[0]).toMatchObject({ enabled: false, suspendedReason: 'bot_removed' });
  expect(state.snapshot().correlations.map(row => row.type)).toEqual(['source-final:source', 'task.finished']);
});
