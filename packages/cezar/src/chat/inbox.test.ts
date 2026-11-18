import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ChatInbox } from './inbox.ts';
import { chatEventSchema, type ChatEvent } from './provider.ts';
import { freshState, InboundStateStore } from './state.ts';
const event = (id = 'socket-envelope:a'): ChatEvent => ({ kind: 'message', id, chat: { id: 'group:TTEAM:UBOT:CCHAN', kind: 'group' }, user: { id: 'UACTOR', label: 'A' }, messageId: '123.456', at: 1000, text: 'answer', addressed: false, replyTo: { chatId: 'group:TTEAM:UBOT:CCHAN', messageId: '123.000' } });
// The default event is a group Reply to this bot's notice, so the core must claim it.
const initial = () => {
 const state = freshState('TTEAM:UBOT', { projectId: 'p', installationId: 'i', root: '/project', generation: randomUUID() }, 'acme/chat');
 state.correlations.push({ receiverId: 'r', chatId: 'group:TTEAM:UBOT:CCHAN', messageId: '123.000', privateChat: false, deliveryRevision: 1, bindingGeneration: randomUUID(),
  enableGeneration: randomUUID(), runId: 'run', type: 'task.completed', sequence: 0, episodeId: 'e', continuation: 0, createdAt: Date.now() });
 return state;
};
describe('non-polling event journal', () => {
 it.each([true, false])('preserves transport pairing eligibility %s before core authorization', async pairingEligible => {
  const state = new InboundStateStore(initial(), { assertOwner() {}, write: async () => {} });
  const process = vi.fn(async () => {});
  await new ChatInbox(state, process).accept({ ...event(), pairingEligible } as ChatEvent);
  expect(process).toHaveBeenCalledWith(expect.objectContaining({
   message: expect.objectContaining({ pairingEligible }),
  }), state.snapshot().epoch);
 });
 it('claims opaque events before processing and serializes simultaneous duplicates', async () => {
  let disk = initial();
  const state = new InboundStateStore(disk, { assertOwner() {}, write: async value => { disk = structuredClone(value); } });
  const process = vi.fn(async update => { expect(disk.receivedEvents.at(-1)?.sequence).toBe(update.sequence); });
  const inbox = new ChatInbox(state, process);
  await Promise.all([inbox.accept(event()), inbox.accept(event()), inbox.accept(event('socket-envelope:b'))]);
  expect(process).toHaveBeenCalledTimes(2);
  expect(process.mock.calls.map(([update]) => update.sequence)).toEqual([0, 1]);
  expect(process.mock.calls[0]![0].message).toMatchObject({ id: '123.456', replyTo: '123.000' });
 });
 it('never replays an uncertain claimed event after a crash or restart', async () => {
  let disk = initial();
  const state = new InboundStateStore(disk, { assertOwner() {}, write: async value => { disk = structuredClone(value); } });
  await expect(new ChatInbox(state, async () => { throw new Error('crash'); }).accept(event())).rejects.toThrow('crash');
  const recovered = new InboundStateStore(disk, { assertOwner() {}, write: async () => {} });
  await recovered.recover();
  const process = vi.fn();
  await new ChatInbox(recovered, process).accept(event());
  expect(process).not.toHaveBeenCalled();
 });
 it('never processes an event whose claim could not be persisted', async () => {
  const state = new InboundStateStore(initial(), { assertOwner() {}, write: async () => { throw new Error('disk unavailable'); } });
  const process = vi.fn();
  await expect(new ChatInbox(state, process).accept(event())).rejects.toThrow();
  expect(process).not.toHaveBeenCalled();
 });
 it('rejects cross-chat message and button receipts before they enter authorization', () => {
  expect(chatEventSchema.safeParse({ ...event(), replyTo: { chatId: 'OTHER', messageId: 'thread:1' } }).success).toBe(false);
  expect(chatEventSchema.safeParse({ kind: 'button', id: 'button:1', chat: { id: 'group:TTEAM:UBOT:CCHAN', kind: 'group' }, user: { id: 'UACTOR', label: 'A' }, receipt: { chatId: 'OTHER', messageId: 'thread:1' }, data: 'opaque' }).success).toBe(false);
 });
});
describe('inbox durability cost', () => {
 const chatter = (n: number, extra: Partial<Extract<ChatEvent, { kind: 'message' }>> = {}): ChatEvent => ({ kind: 'message', id: `socket-envelope:${n}`,
  chat: { id: 'group:TTEAM:UBOT:CCHAN', kind: 'group' }, user: { id: 'USTRANGER', label: 'S' }, messageId: `${1000 + n}.000`, at: 1000, text: 'just chatting', addressed: false, ...extra });
 it('never writes state for group chatter the conversation would ignore, but still claims addressed and correlated events', async () => {
  let writes = 0;
  const state = new InboundStateStore(initial(), { assertOwner() {}, write: async () => { writes++; } });
  const process = vi.fn(async (update, epoch: string) => { await state.finish(epoch, update.sequence); });
  const inbox = new ChatInbox(state, process);
  for (let i = 0; i < 50; i++) await inbox.accept(chatter(i, i % 2 ? { replyTo: { chatId: 'group:TTEAM:UBOT:CCHAN', messageId: '1.000' } } : {}));
  await inbox.accept(chatter(51, { text: '/unknown thing' }));
  expect(writes).toBe(0);
  expect(process).not.toHaveBeenCalled();
  await inbox.accept(chatter(60, { text: '/help', addressed: true }));
  await inbox.accept(chatter(61, { text: '/start abc' }));
  expect(process).toHaveBeenCalledTimes(2);
  expect(state.snapshot().receivedEvents.map(row => row.id)).toEqual(['socket-envelope:60', 'socket-envelope:61']);
 });
 it('claims a group Reply to one of the bot notices', async () => {
  const state = new InboundStateStore(initial(), { assertOwner() {}, write: async () => {} });
  const process = vi.fn(async () => {});
  await new ChatInbox(state, process).accept(event());
  expect(process).toHaveBeenCalledTimes(1);
 });
});
it('preserves classified native commands and chat titles instead of reparsing wire syntax', async () => {
 const state = new InboundStateStore(initial(), {assertOwner(){},write:async()=>{}})
 const process = vi.fn(async()=>{})
 await new ChatInbox(state,process).accept({...event(),kind:'message',messageId:'123.456',at:1000,text:'/task@bot do it',addressed:true,user:{id:'UACTOR',label:'A'},command:{kind:'command',name:'task',args:'do it'},title:'Native group'})
 expect(process).toHaveBeenCalledWith(expect.objectContaining({message:expect.objectContaining({command:{kind:'command',name:'task',args:'do it'},chat:expect.objectContaining({title:'Native group'})})}),state.snapshot().epoch)
})
