import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
const wire = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('undici', () => ({ Agent: class { async close() {} }, request: wire.request }));
import { telegramClient } from './client.ts';
import { TelegramInbound } from './service.ts';
import type { TelegramBotRuntime } from './runtime.ts';
import type { TelegramReplies } from './dispatcher.ts';
import type { InboundStateStore } from './state.ts';
import type { PrivateReceiver } from '../webhooks/endpoints.ts';
import type { RunRecord } from '../runs/store.ts';
import type { ProjectContext } from '../server/project-context.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function response(result: unknown) {
  return { statusCode: 200, body: Object.assign((async function* () {
    yield Buffer.from(JSON.stringify({ ok: true, result }));
  })(), { destroy() {} }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each(['token', 'DNS'].flatMap(barrier => ['revocation', 'lease loss'].map(loss => ({ barrier, loss }))))('service $loss fences a runtime reply blocked at $barrier preparation', async ({ barrier, loss }) => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const directory = await mkdtemp(join(tmpdir(), 'telegram-service-transport-'));
  const botId = String(randomInt(100000, 99999999));
  const entered = deferred(), release = deferred();
  let armed = false;
  const pause = async () => { if (armed) { armed = false; entered.resolve(); await release.promise; } };
  const tokenRead = vi.fn(async () => { if (barrier === 'token') await pause(); return botId + ':' + 'A'.repeat(35); });
  const lookup = vi.fn(async () => { if (barrier === 'DNS') await pause(); return [{ address: '8.8.8.8', family: 4 }]; });
  const call = telegramClient({ token: tokenRead, lookup, policy: { mode: 'local', allowLocalNetwork: false, serverPorts: [] } });
  wire.request.mockImplementation(async (url, options) => {
    const method = new URL(url).pathname.split('/').at(-1);
    if (method === 'getUpdates') {
      await new Promise<void>(resolve => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return response([]);
    }
    return response(method === 'getMe' ? { id: Number(botId), username: 'test_bot' }
      : method === 'sendMessage' ? { message_id: 77 } : true);
  });
  const receivers = ['456', '789'].map(telegramChatId => ({
    id: randomUUID(), revision: 1, deliveryRevision: 1, format: 'telegram.v1', telegramChatId,
    state: 'active', lastTest: 'success', profile: 'standard', events: ['task.attention_required'],
    url: 'https://api.telegram.org/bot123:synthetic/sendMessage', telegramSecret: { sha256: 'a'.repeat(64) },
  } as PrivateReceiver));
  const storedRuns = new Map<string, RunRecord>();
  const service = new TelegramInbound({
    projectId: 'project', root: directory, directory, installationId: randomUUID(), mode: 'local',
    receivers: () => receivers, call: () => call,
    context: async () => ({ root: directory, dataDir: directory, store: { getRun: (id: string) => storedRuns.get(id), redactRunText: (_id: string, text: string) => text } } as unknown as ProjectContext),
    deliver: vi.fn(), episode: () => undefined, changed() {}, now: () => Date.now(),
  });
  try {
    for (const receiver of receivers) {
      const pair = () => service.pair({ receiverId: receiver.id,
        expectedRevision: service.list().receivers.find(row => row.receiverId === receiver.id)!.inboundRevision, dedicatedBot: true });
      if (receiver === receivers[1]) await expect(pair()).rejects.toMatchObject({ code: 'revision_required' });
      const pairing = await pair();
      service.pairings.accept(botId, 'test_bot', { message_id: 1, date: Math.ceil(Date.now() / 1000),
        chat: { id: Number(receiver.telegramChatId), type: 'private' },
        from: { id: Number(receiver.telegramChatId), is_bot: false },
        text: '/start ' + new URL(pairing.deepLink).searchParams.get('start'),
        entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
      await service.confirm(pairing.pairingId, { expectedRevision: service.pairing(pairing.pairingId).inboundRevision,
        candidateUserId: receiver.telegramChatId! });
    }
    // Inspect the service-created runtime; never replace its call adapter, client or dispatcher.
    const bot = (service as unknown as { bots: Map<string, { state: InboundStateStore;
      lease: import('./ownership.ts').BotLease; runtime: TelegramBotRuntime }> }).bots.get(botId)!;
    const runtime = bot.runtime as unknown as { observeRun(run: RunRecord): Promise<void>; replies: TelegramReplies };
    const sends = () => wire.request.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/sendMessage'));
    await vi.waitFor(() => expect(sends()).toHaveLength(2));
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(2000);
    const runs = receivers.map(receiver => {
      const grant = service.list().grants.find(row => row.receiverId === receiver.id)!;
      const source = { id: randomUUID(), botId, epoch: bot.state.snapshot().epoch, projectId: 'project',
        receiverId: receiver.id, grantId: grant.id, grantGeneration: grant.generation, enableGeneration: grant.enableGeneration,
        chatId: grant.chatId, userId: grant.userId, sourceMessageId: 1, updateId: 1, episodeId: randomUUID(),
        requestId: randomUUID(), state: 'finished' as const, createdAt: Date.now(), updatedAt: Date.now(), runId: randomUUID() };
      return { id: source.runId, title: 'Private task result', status: 'done', steps: [], telegramSource: source,
        workflow: 'quick-task', task: 'Private task result', createdAt: new Date().toISOString(), tokensUsed: 0, archived: false } satisfies RunRecord;
    });
    for (const run of runs) storedRuns.set(run.id, run);
    await bot.state.change(state => { state.sources.push(...runs.map(run => run.telegramSource!)); });
    const deliveries: { sent: ReturnType<typeof vi.fn>; failed: ReturnType<typeof vi.fn>; settled: ReturnType<typeof vi.fn> }[] = [];
    const deliver = runtime.replies.deliver.bind(runtime.replies);
    vi.spyOn(runtime.replies, 'deliver').mockImplementation((chat, text, delivery, button) => {
      const callbacks = { sent: vi.fn(delivery.sent), failed: vi.fn(delivery.failed), settled: vi.fn(delivery.settled) };
      deliveries.push(callbacks);
      return deliver(chat, text, { ...delivery, ...callbacks }, button);
    });
    wire.request.mockClear(); tokenRead.mockClear();
    armed = true;
    await runtime.observeRun(runs[0]!);
    await vi.advanceTimersByTimeAsync(0); await entered.promise;
    expect(wire.request).not.toHaveBeenCalled();
    const grant = service.list().grants.find(row => row.chatId === '456')!;
    if (loss === 'lease loss') await bot.lease.release();
    else await service.revoke(grant.id, service.list().receivers.find(row => row.receiverId === grant.receiverId)!.inboundRevision);
    if (loss === 'revocation') expect(service.list().grants.map(row => row.chatId)).toEqual(['789']);
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(wire.request).not.toHaveBeenCalled();
    expect(deliveries[0]!.sent).not.toHaveBeenCalled();
    expect(deliveries[0]!.failed).not.toHaveBeenCalled();
    expect(deliveries[0]!.settled).toHaveBeenCalledTimes(1);
    expect(bot.state.snapshot().correlations).toHaveLength(0);
    if (loss === 'lease loss') return;
    await runtime.observeRun(runs[1]!);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(bot.state.snapshot().correlations).toHaveLength(1));
    expect(wire.request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(wire.request.mock.calls[0]![1].body)).toMatchObject({ chat_id: '789' });
    expect(tokenRead).toHaveBeenCalledTimes(2);
    expect(bot.state.snapshot().correlations[0]).toMatchObject({ chatId: '789', runId: runs[1]!.id });
    expect(deliveries[0]!.settled).toHaveBeenCalledTimes(1);
    expect(deliveries[1]!.sent).toHaveBeenCalledTimes(1);
    expect(deliveries[1]!.settled).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(); vi.useRealTimers();
    await service.dispose(); await rm(directory, { recursive: true, force: true });
  }
}, 15000);
