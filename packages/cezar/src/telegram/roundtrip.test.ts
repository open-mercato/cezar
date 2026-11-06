import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
import { deliverUserMessage } from '../server/run-messages.ts';
import type { ProjectContext } from '../server/project-context.ts';
import type { TelegramCall } from './client.ts';
import type { TelegramUpdate } from './protocol.ts';

it.each([true, false])('roundtrip with structured question=%s: delivery, native Reply through the shared gate, then stale rejection', async structured => {
  vi.stubEnv('CEZ_WEBHOOKS', '1'); vi.stubEnv('CEZ_CHAT_INBOUND', '1');
  const root = await mkdtemp(join(tmpdir(), 'telegram-roundtrip-'));
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 10000 });
  const dataDir = join(root, '.ai/cezar'), botId = randomInt(100000, 99999999);
  let now = Date.now(), messageId = 10;
  const updates: TelegramUpdate[] = []; let wake: (() => void) | undefined;
  const sent: { id: number; text: string }[] = [];
  request.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body); const id = ++messageId; sent.push({ id, text: body.text });
    return { statusCode: 200, headers: {}, body: Object.assign((async function* () {
      yield Buffer.from(JSON.stringify({ ok: true, result: { message_id: id, chat: { id: 456 } } }));
    })(), { once() {}, destroy() {} }) };
  });
  const acknowledgments: string[] = [];
  const call: TelegramCall = async (method, body, signal) => {
    if (method === 'getMe') return { id: botId, username: 'test_bot' };
    if (method === 'sendMessage') { acknowledgments.push(String('text' in body ? body.text : '')); return { message_id: ++messageId, chat: { id: 456 } }; }
    if (method === 'getUpdates') {
      if (!updates.length) await new Promise<void>(resolve => {
        const done = () => { signal?.removeEventListener('abort', done); wake = undefined; resolve(); };
        wake = done; signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done();
      });
      return updates.splice(0);
    }
    throw new Error(`Unexpected method ${method}`);
  };
  const vault = new SecretStore({ ...process.env, CEZ_HOME: join(root, 'vault') }, { keychain: async () => null });
  let service: WebhookService | undefined, store: RunStore | undefined;
  try {
    service = (await WebhookService.open({ root, dataDir, projectId: 'project', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now,
      telegramSecrets: new TelegramSecrets({ kind: 'project', projectId: 'project', root }, vault), telegramCall: () => call,
      send: input => sendWebhook(input, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] }),
    }))!;
    store = RunStore.open(dataDir);
    const sendMessage = vi.fn(() => true), gate = vi.fn(async () => null);
    const manager = { isActive: () => true, sendMessage, enqueueMessage: vi.fn(), deferMessage: vi.fn() };
    const project = { root, dataDir, store, manager } as unknown as ProjectContext;
    service.attach(store, manager, true);
    service.setTelegramInteractions({ context: async () => project, deliver: (context, run, text, check) => deliverUserMessage(context, run, { text, images: [] }, {
      providerActionError: gate, resolveAttachments: () => [], beforeEffect: check,
    }) });
    const { receiver } = await service.create({ name: 'Roundtrip', format: 'telegram.v1', url: `https://api.telegram.org/bot${botId}:${'A'.repeat(35)}/sendMessage`, telegramChatId: '456', profile: 'standard', graceSeconds: 0 });
    await service.test(receiver.id, { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: 'initial-test' });
    await service.tick(); await service.activate(receiver.id, service.list().receivers[0]!.revision);
    const pairing = await service.telegram.pair({ receiverId: receiver.id, expectedRevision: service.telegram.list().receivers[0]!.inboundRevision, dedicatedBot: true });
    const push = (id: number, text: string, reply?: number) => {
      updates.push({ update_id: id, message: { message_id: id, date: Math.ceil(now / 1000), from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' }, text,
        ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
        ...(reply ? { reply_to_message: { message_id: reply } } : {}),
      } }); wake?.();
    };
    push(1, `/start ${new URL(pairing.deepLink).searchParams.get('start')}`);
    await vi.waitFor(() => expect(service!.telegram.pairing(pairing.pairingId).status).toBe('candidate'));
    await service.telegram.confirm(pairing.pairingId, { expectedRevision: service.telegram.pairing(pairing.pairingId).inboundRevision, candidateUserId: '456' });
    // The approval notice shares the Telegram chat budget with the first task
    // notification. Let that queued reply complete before asserting delivery.
    now += 2000;
    await vi.waitFor(() => expect(acknowledgments.some(text => text.startsWith('Access granted'))).toBe(true));
    const run = store.createRun({ title: 'Roundtrip task', task: 'Test', workflow: 'test', steps: [] });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting', ...(structured ? { attentionRequest: { requestId: 'q1', askedAt: new Date(now).toISOString(), questions: [{ question: 'Which option?', options: [{ label: 'A', description: 'First option' }, { label: 'B', description: 'Second option' }] }] } } : {}) });
    now += 2000; await service.tick();
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5000 }); const question = sent.at(-1)!;
    expect(question.text.includes('Which option?')).toBe(structured);
    // Two-way is active for this receiver, so the notification invites a Reply.
    expect(question.text.includes('Reply to this message to answer the task')).toBe(true);
    push(2, 'A', question.id);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(run.id, [{ type: 'text', text: '[via Telegram] A' }]));
    expect(gate).toHaveBeenCalledTimes(1);
    expect(acknowledgments.some(text => text.startsWith('Delivered to task'))).toBe(false);
    now += 3000; // Pairing confirmations, the question and the acknowledgment share the chat budget.
    // "Access granted" is queued, not dropped, so it takes one more per-chat slot first.
    await vi.waitFor(() => expect(acknowledgments.some(text => text.startsWith('Access granted'))).toBe(true), { timeout: 5000 });
    now += 1500;
    await vi.waitFor(() => expect(acknowledgments.some(text => text.startsWith('Delivered to task'))).toBe(true), { timeout: 5000 });
    // The actual private location is discovered below to avoid coupling this test to storage layout.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(dataDir, 'webhooks'), { recursive: true });
    const file = files.find(file => file.endsWith(`${botId}.json`))!;
    const disk = JSON.parse(await readFile(join(dataDir, 'webhooks', file), 'utf8'));
    expect(disk.journal.find((row: { updateId: number }) => row.updateId === 2).state).toBe('accepted');
    const previousQuestion = store.getRun(run.id)!.attentionRequest!;
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting', ...(structured ? { attentionRequest: { ...previousQuestion, requestId: 'q2', askedAt: new Date(now).toISOString() } } : {}) });
    now += 2000; await service.tick();
    push(3, 'old answer', question.id);
    await vi.waitFor(() => expect(service!.telegram.activity({ limit: 50 }).entries.some(row => row.reason === 'stale_reply')).toBe(true));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const newest = sent.at(-1)!; expect(newest.id).not.toBe(question.id);
    push(4, 'B', newest.id);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(run.id, [{ type: 'text', text: '[via Telegram] B' }]);
  } finally { await service?.dispose(); store?.flush(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); request.mockReset(); }
}, 15000);
