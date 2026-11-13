import { setTimeout as allowIO } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage, ChatSession, ChatProviderId } from '../provider.ts';
import { ChatTransportError } from '../provider.ts';
import type { ChatPresentation } from '../presentation.ts';
import { ChatBotRuntime } from '../runtime.ts';
import { freshState, InboundStateStore } from '../state.ts';
import { Pairings } from '../pairing.ts';
import type { ChatConnectionOptions } from '../connection.ts';
import type { BotLease } from '../ownership.ts';
import type { PrivateReceiver } from '../../webhooks/endpoints.ts';
import type { ProjectContext } from '../../server/project-context.ts';
import type { RunRecord } from '../../runs/store.ts';
import { ChatSendBudget } from '../send-budget.ts';

/** Every new provider supplies its real renderer/session over a simulated platform to this unchanged suite. */
export interface SimulatedProvider {
 id: ChatProviderId; botId: string; userId: string; privateChat: string; groupChat: string;
 presentation: ChatPresentation;
 session(send: (chatId: string, message: ChatMessage) => Promise<{ chatId: string; messageId: string }>): ChatSession;
 messageId(index: number): string;
}
export function providerConformance(name: string, provider: SimulatedProvider): void {
 describe(`shared chat conformance: ${name}`, () => {
  async function fixture(group = false, contextGate?: () => Promise<void>) {
   vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
   let now = Date.now(), sequence = 0, limit = false;
   const chatId = group ? provider.groupChat : provider.privateChat;
   const initial = freshState(provider.botId, { projectId: 'p', installationId: 'i', root: '/nonexistent', generation: randomUUID() }, provider.id);
   const generation = randomUUID();
   initial.receivers.push({ receiverId: 'receiver', chatId, enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
   initial.grants.push({ id: randomUUID(), receiverId: 'receiver', chatId, userId: provider.userId, label: 'Person', permissions: ['respond', 'start'], capability: 'task_control', generation: randomUUID(), enableGeneration: generation, approvedAt: 0 });
   let disk = structuredClone(initial);
   const state = new InboundStateStore(initial, { assertOwner() {}, write: async value => { disk = structuredClone(value); }, now: () => now });
   const receiver = { url: 'https://simulated.invalid/destination', secret: '', id: 'receiver', format: `${provider.id}.v1`, chatId, state: 'active', lastTest: 'success', profile: 'standard', preset: 'attention', events: ['task.attention_required'], deliveryRevision: 1, chatSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
   const runs = new Map<string, RunRecord>(), events = new EventEmitter();
   const project = { id: 'p', root: '/nonexistent', dataDir: '/nonexistent', store: { listRuns: () => [...runs.values()], getRun: (id: string) => runs.get(id), redactRunText: (_id: string, text: string) => text, on: events.on.bind(events), off: events.off.bind(events) } } as unknown as ProjectContext;
   const sent: Array<{ chatId: string; message: ChatMessage; messageId: string }> = [];
   const session = provider.session(async (chatId, message) => {
    if (limit) { limit = false; throw new ChatTransportError({ kind: 'rate_limited', retryAfterMs: 1100 }); }
    const receipt = { chatId, messageId: provider.messageId(sent.length + 1) }; sent.push({ ...receipt, message }); return receipt;
   });
   let membership: boolean | undefined = true;
   session.isMember = async () => membership;
   let connection!: ChatConnectionOptions;
   const delivered: string[] = [];
   const createTask = vi.fn(async (_project, text, source, check) => {
    expect(disk.sources.at(-1)?.state).toBe('claimed'); expect(check()).toBeUndefined();
    const run = { id: source.runId, title: text, status: 'running', steps: [], createdAt: new Date(now).toISOString(), chatSource: source } as unknown as RunRecord;
    runs.set(run.id, run); return { created: true as const, runId: run.id };
   });
   const runtime = new ChatBotRuntime({ botId: provider.botId, state, presentation: provider.presentation, session, pairings: new Pairings(provider.presentation, () => now),
    lease: { assertOwner() {}, async validate() {} } as unknown as BotLease, budget: new ChatSendBudget(() => now),
    receiver: () => receiver, receivers: () => [receiver], context: async () => { await contextGate?.(); return project; }, createTask,
    deliver: async (_p, _run, text, check) => { expect(disk.journal.at(-1)?.state).toBe('claimed'); expect(check()).toBeUndefined(); delivered.push(text); return { status: 200, body: { delivered: true } }; },
    episode: () => 'episode-1', assertCredentials: async () => {}, changed() {}, now: () => now,
    connect(options) { connection = options; return { start() {}, async stop() {}, health: () => ({ state: 'polling' }) }; },
   });
   await runtime.start();
   const user = { id: provider.userId, label: 'Person' }, chat = { id: chatId, kind: group ? 'group' as const : 'private' as const };
   const send = async (text: string, replyTo?: string) => {
    const id = `event:${++sequence}`;
    await connection.accept({ kind: 'message', id, chat, user, at: now, text, messageId: provider.messageId(100 + sequence), addressed: false,
     ...(replyTo ? { replyTo: { chatId, messageId: replyTo } } : {}) });
   };
   const pump = async () => { now += 1200; await vi.advanceTimersByTimeAsync(1200); await allowIO(10); };
   const tap = async (row: typeof sent[number], choice = 0, eventId = `event:${++sequence}`) => {
    await connection.accept({ kind: 'button', id: eventId, chat, user, receipt: { chatId, messageId: row.messageId }, data: row.message.buttons![0]![choice]!.data });
   };
   return { receiver, state, sent, runs, events, createTask, delivered, send, pump, tap, connection, user, chat, limit: () => { limit = true; },
    member: (value: boolean | undefined) => { membership = value; now += 61_000; },
    async close() { await runtime.stop(); vi.useRealTimers(); } };
  }
  it('pairs with a provider discovery link and opaque identities', () => {
   let code = '';
   const pairings = new Pairings({ ...provider.presentation, discoveryLink(username, value) { code = value; return provider.presentation.discoveryLink(username, value); } }, () => 10000);
   const { session, deepLink } = pairings.create({ receiverId: 'r', botId: provider.botId, chatId: provider.privateChat, deliveryRevision: 1 }, 'bot');
   expect(deepLink).toBe(provider.presentation.discoveryLink('bot', code));
   expect(pairings.accept(provider.botId, 'bot', { id: provider.messageId(1), at: 10000, chat: { id: provider.privateChat, kind: 'private' }, user: { id: provider.userId, label: 'Person' }, text: `/start ${code}`, command: { kind: 'command', name: 'start', args: code }, addressed: true })).toBe('candidate');
   expect(pairings.get(session.id)?.candidate?.userId).toBe(provider.userId);
  });
  it('requires Confirm, claims durably, deduplicates and sends a final to the same chat', async () => {
   const x = await fixture(); try {
    await x.send('/task implement the change'); await x.pump(); expect(x.createTask).not.toHaveBeenCalled();
    const preview = x.sent.find(row => row.message.buttons)!; await x.tap(preview, 0, 'confirm-event');
    await x.tap(preview, 0, 'confirm-event'); expect(x.createTask).toHaveBeenCalledTimes(1);
    await x.pump();
    const run = [...x.runs.values()][0]!; run.status = 'review'; run.finishedAt = new Date().toISOString(); x.events.emit('run', run);
    for (let tick = 0; tick < 100 && !x.sent.some(row => row.chatId === provider.privateChat && row.message.text.includes('ready')); tick++) await x.pump();
    expect(x.sent.some(row => row.chatId === provider.privateChat && row.message.text.includes('ready')), JSON.stringify(x.sent)).toBe(true);
    expect(x.state.snapshot().sources[0]).toMatchObject({ provider: provider.id, chatId: provider.privateChat, state: 'finished' });
   } finally { await x.close(); }
  });
  it('answers a question with a one-time option button', async () => {
   const x = await fixture(); try {
    const run = { id: '12345678-abcd-4000-8000-123456789abc', title: 'Question', status: 'waiting', steps: [], attentionRequest: { requestId: randomUUID(), askedAt: new Date().toISOString(), questions: [{ header: 'Choice', question: 'Choose?', multiSelect: false, options: [{ label: 'Yes', description: 'Proceed' }, { label: 'No', description: 'Stop' }] }] } } as unknown as RunRecord;
    x.runs.set(run.id, run); await x.send(`/status ${run.id}`); await x.pump();
    const question = x.sent.find(row => row.message.buttons)!; expect(question).toBeDefined();
    await x.tap(question); await x.tap(question); expect(x.delivered).toHaveLength(1); expect(x.delivered[0]).toContain('Yes');
   } finally { await x.close(); }
  });
  it('routes a group thread reply without a mention and ignores unrelated group text', async () => {
   const x = await fixture(true); try {
    const run = { id: '12345678-abcd-4000-8000-123456789abc', title: 'Task', status: 'waiting', steps: [] } as unknown as RunRecord; x.runs.set(run.id, run);
    await x.state.change(state => state.correlations.push({ receiverId: 'receiver', chatId: provider.groupChat, messageId: provider.messageId(55), privateChat: false, deliveryRevision: 1,
     bindingGeneration: state.binding.generation, enableGeneration: state.receivers[0]!.generation, runId: run.id, type: 'task.attention_required', sequence: 1, episodeId: 'episode-1', continuation: 0, createdAt: Date.now() }));
    await x.send('unrelated conversation'); expect(x.delivered).toHaveLength(0);
    await x.send('the answer', provider.messageId(55)); expect(x.delivered).toHaveLength(1);
   } finally { await x.close(); }
  });
  it('retries a provider rate limit under the shared budget', async () => {
   const x = await fixture(); try { x.limit(); await x.send('/tasks'); await x.pump(); await x.pump(); expect(x.sent).toHaveLength(1); } finally { await x.close(); }
  });
  it('fences a rotated credential until its binding is verified, retaining grants', async () => {
   const x = await fixture(); try {
    const grants = x.state.snapshot().grants;
    x.receiver.chatSecret!.sha256 = 'b'.repeat(64);
    await x.send('/tasks'); expect(x.createTask).not.toHaveBeenCalled();
    expect(x.state.snapshot().journal.at(-1)?.reason).toBe('unauthorized');
    await x.state.change(state => { state.receivers[0]!.credentialFingerprint = 'b'.repeat(64); });
    await x.send('/tasks'); await x.pump(); expect(x.state.snapshot().journal.at(-1)?.reason).toBe('read');
    expect(x.state.snapshot().grants).toEqual(grants);
   } finally { await x.close(); }
  });
  it('offers task autocomplete only to a current group member', async () => {
   const x = await fixture(true); try {
    const run = { id: '12345678-abcd-4000-8000-123456789abc', title: 'Task', status: 'waiting', steps: [] } as unknown as RunRecord; x.runs.set(run.id, run);
    const tasks = x.connection.nativeCommands!.tasks;
    expect(await tasks('', provider.groupChat, provider.userId)).toHaveLength(1);
    x.member(false);
    expect(await tasks('', provider.groupChat, provider.userId)).toEqual([]);
    x.member(undefined);
    expect(await tasks('', provider.groupChat, provider.userId)).toEqual([]);
   } finally { await x.close(); }
  });
  it.each(['revoke', 'disable', 'binding', 'grant-generation', 'stop'] as const)('fences native task choices after %s during context lookup', async change => {
   let hold = false;
   let entered!: () => void, release!: () => void;
   const pending = new Promise<void>(resolve => { release = resolve; });
   const arrived = new Promise<void>(resolve => { entered = resolve; });
   const x = await fixture(false, async () => { if (hold) { entered(); await pending; } });
   try {
    const run = { id: '12345678-abcd-4000-8000-123456789abc', title: 'Confidential title', status: 'waiting', steps: [] } as unknown as RunRecord;
    x.runs.set(run.id, run);
    expect(await x.connection.nativeCommands!.tasks('', provider.privateChat, provider.userId)).toHaveLength(1);
    hold = true;
    const choices = x.connection.nativeCommands!.tasks('', provider.privateChat, provider.userId);
    await arrived;
    if (change === 'stop') await x.close();
    else await x.state.change(state => {
     if (change === 'revoke') state.grants = [];
     if (change === 'disable') state.receivers[0]!.enabled = false;
     if (change === 'binding') state.binding.generation = randomUUID();
     if (change === 'grant-generation') state.grants[0]!.generation = randomUUID();
    });
    release();
    expect(await choices).toEqual([]);
   } finally { release(); await x.close(); }
  });
  it('suspends a removed group without revoking its grants', async () => {
   const x = await fixture(true); try {
    await x.connection.accept({ kind: 'membership', id: 'removed-event', chat: x.chat, reason: 'removed' });
    expect(x.state.snapshot().receivers[0]).toMatchObject({ enabled: false, suspendedReason: 'bot_removed' }); expect(x.state.snapshot().grants).toHaveLength(1);
   } finally { await x.close(); }
  });
 });
}
