import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBotRuntime } from './runtime.ts';
import { freshState, InboundStateStore } from './state.ts';
import type { TelegramReplyDelivery } from './dispatcher.ts';
import type { RunRecord } from '../runs/store.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { TelegramSourceRecord } from '@open-mercato/cezar-contract';
import * as excerpts from '../webhooks/excerpt.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
// Drive the same observer/reconciliation seams as run events and post-update processing.
// Keep delivery controllable so the tests can inspect validity during preparation.
async function harness(chatId = '456') {
  const dataDir = await mkdtemp(join(tmpdir(), 'runtime-audit-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const initial = freshState('123', { projectId: 'p', installationId: 'i', root: '/project', generation: randomUUID() });
  const generation = randomUUID();
  initial.receivers.push({ receiverId: 'r', chatId, enabled: true, generation, acceptAfter: 0, deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64) });
  const grant = { id: randomUUID(), receiverId: 'r', chatId, userId: '456', label: 'person', permissions: ['respond' as const], capability: 'task_control' as const, generation: randomUUID(), enableGeneration: generation, approvedAt: 0 };
  initial.grants.push(grant);
  const state = new InboundStateStore(initial, { assertOwner() {}, async write() {} });
  const receiver = { id: 'r', url: 'https://api.telegram.org/bot123:token/sendMessage', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', includeAgentExcerpt: true,
    events: ['task.attention_required'], telegramChatId: chatId, deliveryRevision: 1, telegramSecret: { sha256: 'a'.repeat(64) } } as PrivateReceiver;
  const runs = new Map<string, RunRecord>();
  const store = Object.assign(new EventEmitter(), { listRuns: vi.fn(() => [...runs.values()]), getRun: vi.fn((id: string) => runs.get(id)), redactRunText: (_id: string, text: string) => text.replaceAll('SECRET_VALUE', '[REDACTED]') });
  const project = { root: '/project', dataDir, store };
  const sent: string[] = [];
  const queue = new Map<string, { text: string; delivery: TelegramReplyDelivery }>();
  let episode = 1;
  const makeRuntime = () => {
    const runtime = new TelegramBotRuntime({ botId: '123', state, lease: { assertOwner() {} }, receiver: () => receiver, receivers: () => [receiver], context: async () => project, episode: (id: string) => `${id}-${episode}` } as unknown as ConstructorParameters<typeof TelegramBotRuntime>[0]);
    const observer = runtime as unknown as { ensureRunObserver(): Promise<void>; observeRun(run: RunRecord): Promise<boolean>; replies: unknown; unregisterRuns?: () => void };
    observer.replies = { cancel(key: string) { queue.get(key)?.delivery.settled?.('superseded'); queue.delete(key); }, deliver(_chat: string, text: string, delivery: TelegramReplyDelivery) { queue.set(delivery.key!, { text, delivery }); return true; } };
    cleanups.push(async () => { observer.unregisterRuns?.(); });
    return { runtime, observer };
  };
  const { runtime, observer } = makeRuntime();
  const flush = async () => {
    for (const [key, row] of queue) {
      queue.delete(key);
      if (row.delivery.valid()) { sent.push(row.text); await row.delivery.sent?.({ message_id: sent.length }); }
      row.delivery.settled?.(row.delivery.valid() ? 'sent' : 'invalid');
    }
  };
  const add = async (status: RunRecord['status'] = 'review', sourceState: TelegramSourceRecord['state'] = 'finished') => {
    const source: TelegramSourceRecord = { id: randomUUID(), botId: '123', epoch: initial.epoch, projectId: 'p', receiverId: 'r', grantId: grant.id, grantGeneration: grant.generation, enableGeneration: generation,
      chatId, userId: '456', sourceMessageId: runs.size + 1, updateId: runs.size + 1, episodeId: randomUUID(), requestId: randomUUID(), runId: randomUUID(), state: sourceState, createdAt: Date.now(), updatedAt: Date.now() };
    await state.change(s => { s.sources.push(source); });
    const run = { id: source.runId!, title: 'Task', status, steps: [], archived: false, telegramSource: source } as unknown as RunRecord;
    runs.set(run.id, run); return run;
  };
  const observe = async (run: RunRecord) => { runs.set(run.id, run); await observer.observeRun(run); };
  const transcript = async (run: RunRecord, text: string) => { await mkdir(join(dataDir, 'runs'), { recursive: true }); await writeFile(join(dataDir, 'runs', `${run.id}.ndjson`), JSON.stringify({ type: 'text', text, ts: new Date().toISOString() }) + '\n'); };
  return { state, receiver, store, runs, sent, queue, runtime, observer, makeRuntime, flush, add, observe, transcript, nextEpisode: () => { episode++; } };
}
const continued = (run: RunRecord, status: RunRecord['status']) => ({ ...run, status, steps: [{ id: 'continue-1', status: 'running', backend: 'claude' }] } as RunRecord);

describe('source lifecycle receipts', () => {
  it.each(['done', 'failed'] as const)('delivers each continuation final once, including after restart: %s', async status => {
    const h = await harness(), run = await h.add();
    await h.observe(run); await h.flush();
    await h.observe(continued(run, 'running')); await h.flush();
    const next = continued(run, status);
    await h.observe(next); await h.observe(next); await h.flush();
    expect(h.sent.filter(text => /Task (ready for review|completed|failed)/.test(text))).toHaveLength(2);
    const receipts = h.state.snapshot().correlations.filter(row => row.type.startsWith('source-final:'));
    expect(receipts.map(row => row.continuation)).toEqual([0, 1]);
    expect(receipts.every(row => row.type.length <= 64)).toBe(true);
    const restarted = h.makeRuntime(); await restarted.observer.ensureRunObserver();
    await vi.waitFor(() => expect(h.store.getRun).toHaveBeenCalled());
    await restarted.observer.observeRun(next); await h.flush();
    expect(h.sent.filter(text => /Task (ready for review|completed|failed)/.test(text))).toHaveLength(2);
  });
  it('bounds terminal readmission retries and backs off while the queue stays full', async () => {
    const h = await harness(), run = await h.add('done');
    const deliver = vi.fn(() => false);
    (h.observer.replies as { deliver: typeof deliver }).deliver = deliver;
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    await h.observe(run);
    await h.observe(run);
    expect(deliver).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 12; attempt++) {
      clock += 60_001;
      await h.observe(run);
      await h.state.drain();
    }
    expect(deliver).toHaveBeenCalledTimes(9); // first admission plus eight bounded retries
    expect(h.state.snapshot().sources[0]?.state).toBe('delivery_failed');
  });

  it('suppresses queued notices from a previous continuation', async () => {
    const h = await harness(), run = await h.add();
    await h.observe(run);
    await h.observe(continued(run, 'running')); await h.flush();
    expect(h.sent.some(text => text.includes('ready for review'))).toBe(false);
  });
  it('keeps legacy continuation-zero receipts and permits a new continuation', async () => {
    const h = await harness(), run = await h.add();
    const source = run.telegramSource!;
    await h.state.change(state => { state.correlations.push({ receiverId: 'r', chatId: '456', messageId: 99,
      deliveryRevision: 1, bindingGeneration: state.binding.generation, enableGeneration: source.enableGeneration,
      runId: run.id, type: `source-final:${source.id}`, sequence: 2, episodeId: source.episodeId, continuation: 0, createdAt: Date.now() }); });
    await h.observe(run); await h.flush(); expect(h.sent).toHaveLength(0);
    await h.observe(continued(run, 'done')); await h.flush(); expect(h.sent).toHaveLength(1);
  });
  it('records the actual continuation on progress and deduplicates it after restart', async () => {
    const h = await harness(), run = await h.add('waiting');
    await h.observe(run); await h.flush();
    const next = continued(run, 'waiting'); await h.observe(next); await h.flush();
    expect(h.sent).toHaveLength(2);
    expect(h.state.snapshot().correlations.map(row => row.continuation)).toEqual([0, 1]);
    const restarted = h.makeRuntime(); await restarted.observer.observeRun(next); await h.flush();
    expect(h.sent).toHaveLength(2);
  });
  it('sends no "Task in progress" right after the start, only after another notice', async () => {
    const h = await harness(), run = await h.add('running');
    await h.observe(run); await h.flush();
    expect(h.sent).toEqual([]);
    await h.observe({ ...run, status: 'waiting' } as RunRecord); await h.flush();
    await h.observe(run); await h.flush();
    expect(h.sent).toHaveLength(2); expect(h.sent[1]).toContain('Task in progress');
  });
  it('replaces queued prose from an older attention episode', async () => {
    const h = await harness(), run = await h.add('waiting');
    await h.transcript(run, 'Old question'); await h.observe(run);
    h.nextEpisode(); await h.transcript(run, 'New question'); await h.observe(run); await h.flush();
    expect(h.sent).toHaveLength(1); expect(h.sent[0]).toContain('New question');
    expect(h.sent[0]).not.toContain('Old question');
  });
  it('delivers a second prose waiting episode without a structured request', async () => {
    const h = await harness(), run = await h.add('waiting');
    await h.observe(run); await h.flush();
    // A new continuation is a new attention episode even without CEZ:ASK.
    await h.observe(continued(run, 'waiting')); await h.flush();
    expect(h.sent).toHaveLength(2);
  });
});

describe('source settlement reconciliation', () => {
  it('retries transient preparation failure without rescanning reconciled sources', async () => {
    const h = await harness();
    await h.add(); await h.observer.ensureRunObserver(); await h.flush();
    const run = await h.add('failed');
    const internal = h.runtime as unknown as { deps: { context: () => Promise<unknown> } };
    const original = internal.deps.context;
    const context = vi.fn(original).mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('temporary context unavailable'));
    internal.deps.context = context;
    h.store.getRun.mockClear();
    await h.observer.ensureRunObserver(); await h.flush();
    expect(context).toHaveBeenCalledTimes(2); // Outer lookup succeeds, preparation fails.
    expect(h.sent.filter(text => text.includes('Task failed'))).toHaveLength(0);
    await h.observer.ensureRunObserver();
    expect(h.queue.size).toBe(1);
    await h.observe(run); // A concurrent event must share the pending delivery.
    expect(h.queue.size).toBe(1);
    await h.flush();
    expect(h.sent.filter(text => text.includes('Task failed'))).toHaveLength(1);
    expect(h.store.getRun.mock.calls.every(([id]) => id === run.id)).toBe(true);
    const reads = h.store.getRun.mock.calls.length, contexts = context.mock.calls.length;
    await h.observer.ensureRunObserver(); await h.observer.ensureRunObserver();
    expect(h.store.getRun).toHaveBeenCalledTimes(reads);
    expect(context).toHaveBeenCalledTimes(contexts);
    await h.observe(run); await h.flush(); // The durable receipt also deduplicates.
    expect(h.sent.filter(text => text.includes('Task failed'))).toHaveLength(1);
    expect(h.state.snapshot().correlations.filter(row => row.runId === run.id)).toHaveLength(1);
    expect(h.store.listRuns).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'] as const)('observes a newly settled fast %s with an existing listener', async status => {
    const h = await harness(); await h.add(); await h.observer.ensureRunObserver();
    await vi.waitFor(() => expect(h.queue.size).toBe(1)); await h.flush();
    const second = await h.add(status, 'claimed');
    await h.observe(second); expect(h.queue.size).toBe(0);
    await h.state.change(s => { s.sources.find(row => row.runId === second.id)!.state = 'finished'; });
    await h.observer.ensureRunObserver();
    await vi.waitFor(() => expect(h.queue.size).toBe(1)); await h.flush();
    expect(h.runtime.deliversSource(second)).toBe(true);
    await h.observer.ensureRunObserver(); await h.observe(second); await h.flush();
    expect(h.sent.filter(text => text.includes(`Task ${status}`))).toHaveLength(1);
    const reads = h.store.getRun.mock.calls.length;
    await h.observer.ensureRunObserver();
    expect(h.store.getRun.mock.calls.length).toBe(reads);
    expect(h.store.listRuns).toHaveBeenCalledTimes(0);
  });
  it('observes a newly reconciled uncertain source with an existing listener', async () => {
    const h = await harness(); await h.add(); await h.observer.ensureRunObserver();
    await vi.waitFor(() => expect(h.queue.size).toBe(1)); await h.flush();
    const second = await h.add('failed', 'uncertain');
    await h.observer.ensureRunObserver();
    await vi.waitFor(() => expect(h.queue.size).toBe(1)); await h.flush();
    expect(h.state.snapshot().sources.find(row => row.runId === second.id)?.state).toBe('finished');
    expect(h.sent.filter(text => text.includes('Task failed'))).toHaveLength(1);
  });
});

// A group source keeps the excerpt opt-in; a private one gets the reply itself (below).
describe('source prose excerpts', () => {
  it('includes opted-in Standard prose, redacted before clipping and bounded after escaping', async () => {
    const h = await harness('-456'), run = await h.add('waiting');
    await h.transcript(run, `${'Long prose '.repeat(3000)} <>& SECRET_VALUE /home/alice/private/file\nShould I deploy blue or green?\nCEZ:ASK hidden`);
    await h.observe(run); await h.flush();
    expect(h.sent[0]).toContain('Should I deploy blue or green?');
    expect(h.sent[0]).not.toMatch(/SECRET_VALUE|\/home\/alice|CEZ:ASK/);
    expect(h.sent[0]!.length).toBeLessThanOrEqual(4096);
  });
  it.each(['off', 'minimal', 'structured', 'missing'] as const)('omits prose when %s', async kind => {
    const h = await harness('-456'), run = await h.add('waiting');
    if (kind !== 'missing') await h.transcript(run, 'Private prose question');
    if (kind === 'off') h.receiver.includeAgentExcerpt = false;
    if (kind === 'minimal') h.receiver.profile = 'minimal';
    if (kind === 'structured') run.attentionRequest = { requestId: randomUUID(), askedAt: new Date().toISOString(), questions: [{ question: 'Structured question' }] };
    await h.observe(run); await h.flush();
    expect(h.sent).toHaveLength(kind === 'minimal' ? 0 : 1); expect(h.sent.join('')).not.toContain('Private prose question');
  });
  it('rechecks excerpt consent after transcript reads', async () => {
    const h = await harness('-456'), run = await h.add('waiting');
    let resolve!: (value: string) => void;
    const read = vi.spyOn(excerpts, 'safeAgentText').mockReturnValue(new Promise<string>(r => { resolve = r; }));
    const observing = h.observe(run);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    h.receiver.includeAgentExcerpt = false; resolve('Private prose question');
    await observing; await h.flush();
    expect(h.sent.join('')).not.toContain('Private prose question');
  });
  it('rechecks source authorization after transcript reads', async () => {
    const h = await harness('-456'), run = await h.add('waiting');
    let resolve!: (value: string) => void;
    const read = vi.spyOn(excerpts, 'safeAgentText').mockReturnValue(new Promise<string>(r => { resolve = r; }));
    const observing = h.observe(run); await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await h.state.change(state => { state.grants = []; }); resolve('Private prose question');
    await observing; await h.flush(); expect(h.sent).toHaveLength(0);
  });
  it('bounds an HTML-heavy prose excerpt at the raw Telegram send limit', async () => {
    const h = await harness('-456'), run = await h.add('waiting');
    await h.transcript(run, '<>& '.repeat(5000)); await h.observe(run); await h.flush();
    expect(h.sent[0]).toContain('Agent: '); expect(h.sent[0]!.length).toBeLessThanOrEqual(4096);
    expect(h.sent[0]).not.toMatch(/&[a-z]*…/);
  });
  it('invalidates an excerpt already queued when consent is revoked', async () => {
    const h = await harness('-456'), run = await h.add('waiting');
    await h.transcript(run, 'Private prose question'); await h.observe(run);
    expect([...h.queue.values()][0]?.text).toContain('Private prose question');
    h.receiver.includeAgentExcerpt = false; await h.flush();
    expect(h.sent).toHaveLength(0);
  });
});

describe('final replies of tasks started from Telegram', () => {
  it.each(['done', 'review'] as const)('returns the agent’s final message to the requester without excerpt consent: %s', async status => {
    const h = await harness(); h.receiver.includeAgentExcerpt = false;
    const run = await h.add(status);
    await h.transcript(run, 'Last commit: feat x\nSECRET_VALUE at /home/alice/private/file.ts\nCEZ:DONE');
    await h.observe(run); await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('Agent: Last commit: feat x');
    expect(h.sent[0]).not.toMatch(/SECRET_VALUE|\/home\/alice|CEZ:DONE/);
  });
  it('bounds a long final message at the Telegram limit and names the cockpit for the rest', async () => {
    const h = await harness(), run = await h.add('done');
    await h.transcript(run, '<>& word '.repeat(2000)); await h.observe(run); await h.flush();
    expect(h.sent[0]).toContain('Agent: '); expect(h.sent[0]!.length).toBeLessThanOrEqual(4096);
    expect(h.sent[0]).toContain('The full reply is in the cockpit.');
  });
  it('sends the final notice without a reply line when the transcript has none', async () => {
    const h = await harness(), run = await h.add('done');
    await h.observe(run); await h.flush();
    expect(h.sent).toHaveLength(1); expect(h.sent[0]).not.toContain('Agent: ');
  });
  it('returns the agent’s free-text question to the requester without excerpt consent', async () => {
    const h = await harness(); h.receiver.includeAgentExcerpt = false;
    const run = await h.add('waiting');
    await h.transcript(run, 'Casablanca 21:43, Nairobi 00:43.\nRetry the fetch?');
    await h.observe(run); await h.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('Agent: Casablanca 21:43');
    expect(h.sent[0]).toContain('Retry the fetch?');
  });
  it('rechecks source authorization after reading the final message', async () => {
    const h = await harness(), run = await h.add('done');
    let resolve!: (value: string) => void;
    const read = vi.spyOn(excerpts, 'safeAgentText').mockReturnValue(new Promise<string>(r => { resolve = r; }));
    const observing = h.observe(run); await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await h.state.change(state => { state.grants = []; }); resolve('Last commit: feat x');
    await observing; await h.flush(); expect(h.sent).toHaveLength(0);
  });
});
