import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
const request = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ Agent: class { async destroy() {} }, request }));
import { WebhookService } from '../webhooks/service.ts';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import { sendWebhook } from '../webhooks/transport.ts';
import { TelegramSecrets } from '../webhooks/telegram-secrets.ts';
import { SecretStore } from '../workspace/secrets.ts';
import { RunStore } from '../runs/store.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { TelegramCall } from './client.ts';
import type { TelegramUpdate } from './protocol.ts';

// G1: while the bot runtime delivers, webhook admission skips the source chat, so the chat gets one final notice in total.
it.each(['done', 'failed', 'cancelled'] as const)('a source task gets one prose notice and one final per lifecycle, continuing to %s', async status => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const root = await mkdtemp(join(tmpdir(), 'telegram-source-final-'));
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 10000 });
  const dataDir = join(root, '.ai/cezar'), botId = randomInt(100000, 99999999);
  let now = Date.now(), messageId = 10, updateId = 0;
  const updates: TelegramUpdate[] = []; let wake: (() => void) | undefined;
  type Button = { text: string; callback_data: string };
  const webhook: string[] = [], bot: { id: number; text: string; keyboard?: Button[][] }[] = [];
  request.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body); const id = ++messageId; webhook.push(body.text);
    return { statusCode: 200, headers: {}, body: Object.assign((async function* () {
      yield Buffer.from(JSON.stringify({ ok: true, result: { message_id: id, chat: { id: 456 } } }));
    })(), { once() {}, destroy() {} }) };
  });
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: botId, username: 'test_bot' };
    if (method === 'setMyCommands') return true;
    if (method === 'sendMessage') {
      const { text, reply_markup: markup } = body as { text: string; reply_markup?: { inline_keyboard: Button[][] } }, id = ++messageId;
      bot.push({ id, text, ...(markup ? { keyboard: markup.inline_keyboard } : {}) }); return { message_id: id, chat: { id: 456 } };
    }
    if (method === 'answerCallbackQuery' || method === 'editMessageReplyMarkup') return true;
    if (method === 'getUpdates') {
      if (!updates.length) await new Promise<void>(resolve => {
        const done = () => { signal?.removeEventListener('abort', done); wake = undefined; resolve(); };
        wake = done; signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done();
      });
      return updates.splice(0);
    }
    return true;
  };
  const vault = new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault') }, { keychain: async () => null });
  let service: WebhookService | undefined, store: RunStore | undefined;
  try {
    service = (await WebhookService.open({ root, dataDir, projectId: 'project', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now,
      telegramSecrets: new TelegramSecrets({ kind: 'project', projectId: 'project', root }, vault), telegramCall: () => call,
      send: input => sendWebhook(input, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] }),
    }))!;
    const runs = store = RunStore.open(dataDir);
    const manager = { isActive: () => false, sendMessage: vi.fn(), enqueueMessage: vi.fn(), deferMessage: vi.fn() };
    const project = { root, dataDir, store, manager } as unknown as ProjectContext;
    service.attach(store, manager, true);
    service.setTelegramInteractions({ context: async () => project, deliver: vi.fn(),
      createTask: async (_project, text, source) => {
        const run = runs.createRun({ id: source.runId, title: text, task: text, workflow: 'quick-task', steps: [], telegramSource: source });
        runs.updateRun(run.id, { status: 'running' });
        return { created: true, runId: run.id };
      } });
    const { receiver } = await service.create({ name: 'Source', format: 'telegram.v1', url: `https://api.telegram.org/bot${botId}:${'A'.repeat(35)}/sendMessage`, telegramChatId: '456', profile: 'standard', includeAgentExcerpt: true, preset: 'all', graceSeconds: 0 });
    await service.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'initial-test' });
    await service.tick(); await service.activate(receiver.id, service.list().receivers[0]!.revision);
    const pairing = await service.telegram.pair({ receiverId: receiver.id, expectedRevision: service.telegram.list().receivers[0]!.inboundRevision, dedicatedBot: true });
    const push = (text: string) => {
      const id = ++updateId;
      updates.push({ update_id: id, message: { message_id: id, date: Math.ceil(now / 1000), from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' }, text,
        ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}) } }); wake?.();
    };
    push(`/start ${new URL(pairing.deepLink).searchParams.get('start')}`);
    await vi.waitFor(() => expect(service!.telegram.pairing(pairing.pairingId).status).toBe('candidate'));
    await service.telegram.confirm(pairing.pairingId, { expectedRevision: service.telegram.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456', permissions: ['respond', 'start'] });
    now += 2000; push('/task Source final task');
    // Replies are paced per chat on the injected clock, so every poll moves it forward.
    const until = (check: () => boolean) => vi.waitFor(() => { now += 500; expect(check()).toBe(true); }, { timeout: 5000 });
    await until(() => bot.some(row => row.text.startsWith('Start a new task?')));
    const preview = bot.find(row => row.text.startsWith('Start a new task?'))!;
    updates.push({ update_id: ++updateId, callback_query: { id: 'tap', data: preview.keyboard![0]![0]!.callback_data, from: { id: 456, is_bot: false },
      message: { message_id: preview.id, date: Math.ceil(now / 1000), chat: { id: 456, type: 'private' } } } } as TelegramUpdate); wake?.();
    now += 2000;
    await until(() => bot.some(row => /^Started task /.test(row.text)));
    const run = store.listRuns().find(row => row.telegramSource)!;
    const before = { webhook: webhook.length, bot: bot.length };
    await writeFile(join(dataDir, 'runs', `${run.id}.ndjson`), JSON.stringify({ type: 'text', text: 'Should I deploy blue or green?', ts: new Date(now).toISOString() }) + '\n');
    store.updateRun(run.id, { status: 'waiting' });
    await until(() => bot.slice(before.bot).some(row => row.text.includes('Should I deploy blue or green?')));
    for (let index = 0; index < 3; index++) { now += 2000; await service.tick(); }
    expect([...webhook.slice(before.webhook), ...bot.slice(before.bot).map(row => row.text)].filter(text => text.includes('Should I deploy blue or green?'))).toHaveLength(1);
    store.updateRun(run.id, { status: 'review', finishedAt: new Date(now).toISOString() });
    await until(() => bot.slice(before.bot).some(row => row.text.includes('Task ready for review')));
    store.addStep(run.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    // The manager adds the step while the run still reads terminal; the old final must not be resent as this turn's.
    for (let index = 0; index < 8; index++) { now += 2000; await service.tick(); await new Promise(resolve => setTimeout(resolve, 100)); }
    expect(bot.slice(before.bot).filter(row => row.text.includes('Task ready for review'))).toHaveLength(1);
    // A continuation cancelled before it started never leaves `pending`; its final still goes out.
    if (status !== 'cancelled') {
      store.updateStep(run.id, 'continue-1', { status: 'running', startedAt: new Date(now).toISOString() });
      store.updateRun(run.id, { status: 'running', finishedAt: undefined });
      store.updateStep(run.id, 'continue-1', { status });
    }
    store.updateRun(run.id, { status, finishedAt: new Date(now + 1000).toISOString(),
      ...(status === 'done' ? { completionReason: 'completed' } : status === 'failed' ? { error: 'failed continuation' } : {}) });
    for (let index = 0; index < 5; index++) { now += 2000; await service.tick(); }
    await until(() => bot.slice(before.bot).some(row => row.text.includes({ done: 'Task completed', failed: 'Task failed', cancelled: 'Task cancelled' }[status])));
    await new Promise(resolve => setTimeout(resolve, 500));
    for (let index = 0; index < 3; index++) { now += 2000; await service.tick(); }
    const finals = [...webhook.slice(before.webhook), ...bot.slice(before.bot).map(row => row.text)].filter(text => /(?:Task ready for review|Task completed|Task failed|Task cancelled)/.test(text));
    expect(finals).toHaveLength(2);
    for (let index = 0; index < 3; index++) store.updateRun(run.id, { status });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect([...webhook.slice(before.webhook), ...bot.slice(before.bot).map(row => row.text)].filter(text => /(?:Task ready for review|Task completed|Task failed|Task cancelled)/.test(text))).toHaveLength(2);
  } finally { await service?.dispose(); store?.flush(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); request.mockReset(); }
}, 20000);
