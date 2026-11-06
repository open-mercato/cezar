import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { TelegramBotRuntime } from './runtime.ts';
import { BotLease } from './ownership.ts';
import { forgetReplies, freshState, InboundStateStore, type InboundState } from './state.ts';
import { Pairings } from './pairing.ts';
import { TelegramSendBudget } from './send-budget.ts';
import { RunStore } from '../runs/store.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { RunRecord } from '../runs/store.ts';
import type { TelegramSourceRecord } from '@open-mercato/cezar-contract';

vi.setConfig({ testTimeout: 20_000 });
const wait = { timeout: 8000 };
const SLACK = 'https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnopqrstuvwx';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A runtime (re)starting over a Telegram-started task whose source is already durable. */
async function harness(options: { status: RunRecord['status']; webhookFinal?: string; reply?: string }) {
  const botId = String(randomInt(100000, 99999999)), lease = await BotLease.acquire(botId);
  const binding = await lease.bind({ projectId: 'project', installationId: 'installation', root: '/project' });
  const dataDir = await mkdtemp(join(tmpdir(), 'telegram-runtime-final-'));
  const state0 = freshState(botId, binding), enableGeneration = randomUUID(), grantId = randomUUID(), grantGeneration = randomUUID(), runId = `run-${randomInt(1e6)}`;
  state0.receivers.push({ receiverId: 'receiver', chatId: '456', enabled: true, generation: enableGeneration, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  state0.grants.push({ id: grantId, receiverId: 'receiver', chatId: '456', userId: '456', label: 'Person', permissions: ['respond'],
    capability: 'task_control', generation: grantGeneration, enableGeneration, approvedAt: 0 });
  const source: TelegramSourceRecord = { id: randomUUID(), botId, epoch: state0.epoch, projectId: 'project', receiverId: 'receiver', grantId, grantGeneration,
    enableGeneration, chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1, episodeId: `${runId}-1`, requestId: randomUUID(), runId,
    state: 'finished', createdAt: Date.now(), updatedAt: Date.now() };
  state0.sources.push(source);
  // What telegram/service.ts recordDelivery stores when the outbound webhook sent the final first.
  if (options.webhookFinal) state0.correlations.push({ receiverId: 'receiver', chatId: '456', messageId: 7, deliveryRevision: 1, bindingGeneration: binding.generation,
    enableGeneration, runId, type: options.webhookFinal, sequence: 3, episodeId: `${runId}-1`, continuation: 0, createdAt: Date.now() });
  const state = new InboundStateStore(state0, { assertOwner: () => lease.assertOwner(), async write() {} });
  const receiver = { id: 'receiver', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required', 'task.finished'],
    url: `https://api.telegram.org/bot${botId}:${'A'.repeat(35)}/sendMessage`, telegramChatId: '456', deliveryRevision: 1, telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const slack = { id: 'slack', format: 'slack.v1', state: 'active', url: SLACK } as PrivateReceiver;
  if (options.reply) {
    await mkdir(join(dataDir, 'runs'), { recursive: true });
    await writeFile(join(dataDir, 'runs', `${runId}.ndjson`), JSON.stringify({ type: 'text', text: options.reply, ts: new Date(Date.now() - 1000).toISOString() }) + '\n');
  }
  const run = { id: runId, title: 'Ship it', status: options.status, archived: false, steps: [], telegramSource: source,
    ...(options.status === 'done' ? { completionReason: 'completed' } : {}) } as unknown as RunRecord;
  const runs = new Map([[runId, run]]), events = new EventEmitter();
  const redactor = await RunStore.open(dataDir);
  const store = { on: events.on.bind(events), off: events.off.bind(events), listRuns: () => [...runs.values()], getRun: (id: string) => runs.get(id),
    redactRunText: redactor.redactRunText.bind(redactor) };
  const project = { root: '/project', dataDir, store } as unknown as ProjectContext;
  const sent: string[] = [];
  let hold: Promise<void> | undefined;
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: Number(botId), username: 'test_bot' };
    if (method === 'sendMessage') { await hold; sent.push((body as { text: string }).text); return { message_id: 100 + sent.length, chat: { id: 456 } }; }
    if (method === 'getUpdates') return new Promise(resolve => { const timer = setTimeout(() => resolve([]), 10); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve([]); }, { once: true }); });
    return true;
  };
  const budget = new TelegramSendBudget();
  const make = () => new TelegramBotRuntime({ budget, botId, state, lease, pairings: new Pairings(), call, receiver: () => receiver,
    receivers: () => [receiver, slack], assertCredentials: async () => {}, context: async () => project, deliver: vi.fn(), createTask: vi.fn(),
    episode: () => undefined, changed() {} } as unknown as ConstructorParameters<typeof TelegramBotRuntime>[0]);
  const runtimes = [make()], runtime = runtimes[0]!;
  cleanups.push(async () => { for (const next of runtimes) await next.stop(); await lease.release(); await rm(dataDir, { recursive: true, force: true }); });
  /** What a cezar restart builds over the same durable state. */
  const restart = () => { const next = make(); runtimes.push(next); return next; };
  const update = (next: Partial<RunRecord>) => { const latest = { ...runs.get(runId)!, ...next } as RunRecord; runs.set(runId, latest); events.emit('run', latest); };
  return { runtime, restart, state, sent, update, budget, lease, run, slack, hold: (gate: Promise<void> | undefined) => { hold = gate; } };
}
const finals = (sent: string[]) => sent.filter(text => /Task completed|Task ready for review|Task failed|Task cancelled/.test(text));
/** The writes of service.setEnabled, through its own purge. */
const disable = (state: InboundState) => { state.receivers[0]!.enabled = false; forgetReplies(state, row => row.receiverId === 'receiver'); };
const enable = (state: InboundState) => {
  const generation = randomUUID(), bound = state.receivers[0]!;
  bound.enabled = true; bound.generation = generation; bound.acceptAfter = Date.now();
  for (const grant of state.grants) grant.enableGeneration = generation;
  forgetReplies(state, row => row.receiverId === 'receiver');
};

describe('the Telegram runtime final notice', () => {
  it.each(['task.finished', 'task.review_ready', 'task.failed'])('is not sent again when the webhook already delivered %s to the source chat', async type => {
    const x = await harness({ status: 'done', webhookFinal: type });
    await x.runtime.start();
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(finals(x.sent)).toEqual([]);
  });

  it('is sent once when nothing delivered it yet (guard)', async () => {
    const x = await harness({ status: 'done' });
    await x.runtime.start();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(finals(x.sent)).toHaveLength(1);
  });

  it('still reaches the source chat after the requester\'s permissions are edited mid-task', async () => {
    const x = await harness({ status: 'queued', reply: 'Deployed.' });
    await x.runtime.start();
    // What service.permissions() writes: new permissions and a new grant generation.
    await x.state.change(state => { state.grants[0]!.permissions = ['respond', 'cancel']; state.grants[0]!.generation = randomUUID(); });
    expect(x.runtime.deliversSource(x.run)).toBe(true);
    x.update({ status: 'done', completionReason: 'completed' } as Partial<RunRecord>);
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    expect(finals(x.sent)[0]).toContain('Deployed.');
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(finals(x.sent)).toHaveLength(1);
  });

  it('still reaches the source chat after its replies are disabled and enabled again', async () => {
    const x = await harness({ status: 'queued', reply: 'Deployed.' });
    await x.runtime.start();
    await x.state.change(state => { state.receivers[0]!.enabled = false; });
    // What service.setEnabled(true) writes: a new binding generation carried onto the receiver's grants.
    await x.state.change(state => {
      const generation = randomUUID(); state.receivers[0]!.enabled = true; state.receivers[0]!.generation = generation; state.grants[0]!.enableGeneration = generation;
    });
    expect(x.runtime.deliversSource(x.run)).toBe(true);
    x.update({ status: 'done', completionReason: 'completed' } as Partial<RunRecord>);
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    expect(x.state.snapshot().correlations.find(row => row.type.startsWith('source-final:'))?.enableGeneration).toBe(x.state.snapshot().receivers[0]!.generation);
  });

  it('is not sent again by a new runtime after replies are disabled and enabled again', async () => {
    const x = await harness({ status: 'done', reply: 'Deployed.' });
    await x.runtime.start();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    await x.state.change(disable);
    await x.runtime.stop();
    await x.state.change(enable);
    await x.restart().start();
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(finals(x.sent)).toHaveLength(1);
  });

  // A run that finishes while replies are disabled: covered through the real recordDelivery in service.test.ts.
  it('a Continue after Enable still gets its own final (guard)', async () => {
    const x = await harness({ status: 'done', reply: 'Deployed.' });
    await x.runtime.start();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    await x.state.change(disable);
    await x.state.change(enable);
    x.update({ status: 'running', steps: [{ id: 'continue-1', status: 'running', startedAt: new Date().toISOString() }] } as unknown as Partial<RunRecord>);
    await new Promise(resolve => setTimeout(resolve, 200));
    x.update({ status: 'done', completionReason: 'completed', finishedAt: new Date().toISOString(),
      steps: [{ id: 'continue-1', status: 'done', startedAt: new Date().toISOString() }] } as unknown as Partial<RunRecord>);
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(2), wait);
  });

  it.each(['revoked', 'disabled'] as const)('leaves the final to the webhook when the requester\'s access was %s (guard)', async change => {
    const x = await harness({ status: 'queued' });
    await x.runtime.start();
    await x.state.change(state => { if (change === 'revoked') state.grants = []; else state.receivers[0]!.enabled = false; });
    expect(x.runtime.deliversSource(x.run)).toBe(false);
    x.update({ status: 'done', completionReason: 'completed' } as Partial<RunRecord>);
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(finals(x.sent)).toEqual([]);
  });

  it('redacts every live receiver secret from the agent answer, not only this bot’s', async () => {
    const x = await harness({ status: 'done', reply: `Deployed. Post updates to ${SLACK} from now on.` });
    await x.runtime.start();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    expect(finals(x.sent)[0]).toContain('Deployed.');
    expect(finals(x.sent)[0]).not.toContain('hooks.slack.com/services');
    expect(finals(x.sent)[0]).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it.each(['title', 'error', 'questions'] as const)('redacts live receiver secrets in %s metadata', async field => {
    const x = await harness({ status: 'queued' });
    await x.runtime.start();
    x.slack.url = SLACK.replace('abcdefghijklmnopqrstuvwx', 'rotatedReceiverCredential');
    const secret = x.slack.url;
    x.update({ status: field === 'questions' ? 'waiting' : 'failed',
      ...(field === 'title' ? { title: secret } : field === 'error' ? { error: secret } : {
        attentionRequest: { requestId: 'question', askedAt: new Date().toISOString(), questions: [
          { question: secret, options: [{ label: secret, description: secret }] },
        ] },
      }),
    } as Partial<RunRecord>);
    await vi.waitFor(() => expect(x.sent).toHaveLength(1), wait);
    expect(x.sent[0]).not.toContain('rotatedReceiverCredential');
  });

  it('does not send source content after losing ownership', async () => {
    const x = await harness({ status: 'queued' });
    await x.runtime.start();
    await x.lease.release();
    x.update({ status: 'done' });
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(x.sent).toEqual([]);
  });

  it('reconciles an archived terminal snapshot invalidated during budget cooldown', async () => {
    const x = await harness({ status: 'done' });
    x.budget.cooldown(Date.now() + 1500);
    await x.runtime.start();
    expect(x.runtime.deliversSource(x.run)).toBe(true);
    x.update({ archived: true });
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), wait);
    expect(x.state.snapshot().correlations.filter(row => row.type.startsWith('source-final:'))).toHaveLength(1);
  });

  it('reconciles a terminal retry dropped when its chat queue fills', async () => {
    const x = await harness({ status: 'queued' });
    await x.runtime.start();
    let reject!: (error: Error) => void;
    x.hold(new Promise<void>((_resolve, fail) => { reject = fail; }));
    x.update({ status: 'done' });
    await new Promise(resolve => setTimeout(resolve, 250));
    for (let i = 0; i < 10; i++) x.runtime.notify('456', 'filler');
    expect(x.runtime.deliversSource(x.run)).toBe(true);
    x.hold(undefined); reject(new TelegramApiError('network'));
    await vi.waitFor(() => expect(x.runtime.health().droppedReplies).toBeGreaterThan(0), wait);
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), { timeout: 15000 });
    expect(x.state.snapshot().correlations.filter(row => row.type.startsWith('source-final:'))).toHaveLength(1);
  });

  it('never reconciles an accepted final when its receipt write fails', async () => {
    const x = await harness({ status: 'queued' });
    await x.runtime.start();
    vi.spyOn(x.state, 'change').mockRejectedValueOnce(new Error('receipt storage failed'));
    x.update({ status: 'done' });
    await vi.waitFor(() => expect(x.state.snapshot().sources[0]?.state).toBe('delivery_failed'), wait);
    x.update({ archived: true });
    await new Promise(resolve => setTimeout(resolve, 2200));
    expect(finals(x.sent)).toHaveLength(1);
    expect(x.state.snapshot().correlations).toEqual([]);
  });

  it('retries a final the reply queue refused instead of losing it', async () => {
    const x = await harness({ status: 'running' });
    await x.runtime.start();
    let release!: () => void;
    x.hold(new Promise<void>(resolve => { release = resolve; }));
    // Fill the bot's reply queue with other chats' notices so the final is refused.
    const fill = () => { for (let index = 0; index < 110; index++) x.runtime.notify(String(1000 + index), `filler ${index}`); };
    fill(); await new Promise(resolve => setTimeout(resolve, 200)); fill(); // the held send left the queue
    const dropped = x.runtime.health().droppedReplies;
    x.update({ status: 'done', completionReason: 'completed' } as Partial<RunRecord>);
    await vi.waitFor(() => expect(x.runtime.health().droppedReplies).toBe(dropped + 1), wait);
    x.hold(undefined); release();
    await vi.waitFor(() => expect(finals(x.sent)).toHaveLength(1), { timeout: 15_000 });
  });
});
