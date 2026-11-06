import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebhookSchema, updateWebhookSchema, webhookEventSchema } from '@open-mercato/cezar-contract';
import { AdmissionRepository } from './admission.ts';
import { privateReceiverSchema } from './endpoints.ts';
import { agentAnswer, agentExcerpt, readLastAgentText, safeAgentText } from './excerpt.ts';
import type { PrivateReceiver } from './endpoints.ts';
import { renderPayload } from './payload.ts';
import { renderDiscordMessage } from './discord.ts';
import { renderSlackMessage } from './slack.ts';
import { renderTelegramMessage } from './telegram.ts';
import type { WebhookSource } from './source.ts';

const dirs: string[] = [];
const now = Date.parse('2026-10-31T12:00:00Z');
const temp = () => { const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-excerpt-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const at = (offset: number) => new Date(now + offset).toISOString();
function history(dir: string, events: Record<string, unknown>[], runId = 'task-1'): void {
  mkdirSync(join(dir, 'runs'), { recursive: true });
  writeFileSync(join(dir, 'runs', `${runId}.ndjson`), events.map((event, seq) => JSON.stringify({ seq, ts: at(-1000), ...event })).join('\n') + '\n');
}
const message = (text: string) => ({ type: 'item.completed', item: { kind: 'message', id: 'item_1', role: 'assistant', text } });
const source = (question = false): WebhookSource => ({
  version: 1, id: 'evt_00000000-0000-4000-8000-000000000002', sequence: 2, installationId: 'inst_test', projectId: 'project', previousStatus: 'running',
  episodeId: 'task-1-2', type: 'task.attention_required', occurredAt: at(0), mode: 'local',
  snapshot: { id: 'task-1', status: 'waiting', archived: false, continuation: 0, title: 'Title',
    ...(question ? { attentionRequest: { requestId: 'question-1', askedAt: at(0), questions: [{ question: 'Pick one?' }] } } : {}) },
});
const receiver = (overrides: Record<string, unknown> = {}, id = '00000000-0000-4000-8000-000000000001') => privateReceiverSchema.parse({
  name: 'Ops', url: 'https://example.com', id, state: 'active', revision: 1, deliveryRevision: 1, secret: 'synthetic-fixture', profile: 'standard',
  activation: { installationId: 'inst_test', sequence: 1 }, createdAt: at(0), updatedAt: at(0), consecutiveFailures: 0, activationBlocked: false, lastTest: 'none', graceSeconds: 0, ...overrides,
});
const telegram = { format: 'telegram.v1', url: 'https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage', telegramChatId: '42' };
const wire = (format: string, body: string) => format === 'slack.v1' ? renderSlackMessage(body) : format === 'discord.v1' ? renderDiscordMessage(body)
  : format === 'telegram.v1' ? renderTelegramMessage(body, { chatId: '42' }) : body;

describe('agent excerpt extraction', () => {
  it('reads the last assistant message of the parked turn, v2 first and v1 as fallback', async () => {
    const dir = temp();
    history(dir, [{ type: 'user-message', text: 'do it' }, message('First thought.'), { type: 'tool-result', result: 'ls output' }, message('Shall I push?'), { type: 'turn-end' }]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBe('Shall I push?');
    history(dir, [{ type: 'user-message', text: 'do it' }, { type: 'text', text: 'Which branch?' }]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBe('Which branch?');
  });
  it('never reaches past the turn, nor into events after the parking moment', async () => {
    const dir = temp();
    history(dir, [message('Old turn text'), { type: 'user-message', text: 'next' }, { type: 'tool-result', result: 'x' }]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBeUndefined();
    history(dir, [message('Parked question?'), { type: 'user-message', text: 'answer', ts: at(5000) }, { ...message('Later turn'), ts: at(6000) }]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBe('Parked question?');
  });
  it.each(['v2', 'v1'])('does not reuse an old question after an empty nudged %s turn', async version => {
    const dir = temp();
    const v2 = version === 'v2';
    history(dir, [
      { type: 'step-start', stepId: 'agent' },
      ...(v2 ? [{ type: 'turn.started', turnId: 'old' }] : []),
      v2 ? message('Old turn: shall I deploy?') : { type: 'text', text: 'Old turn: shall I deploy?' },
      ...(v2 ? [{ type: 'turn.completed', turnId: 'old' }] : []),
      { type: 'turn-end' },
      { type: 'note', message: 'autonomous — continuing without pausing (1/20)' },
      ...(v2 ? [{ type: 'turn.started', turnId: 'new' }, { type: 'turn.completed', turnId: 'new' }] : []),
      { type: 'turn-end' },
    ]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBeUndefined();
    expect(await safeAgentText({ dataDir: dir, runId: 'task-1', until: at(0), kind: 'excerpt', receivers: () => [] })).toBeUndefined();
    expect(await readLastAgentText(dir, 'task-1', at(0), { boundary: 'message' })).toBe('Old turn: shall I deploy?');
  });
  it('stops at a backend turn start even before its completion, but respects the parking timestamp', async () => {
    const dir = temp();
    history(dir, [message('Parked question?'), { type: 'turn.completed', turnId: 'old' },
      { type: 'turn-end' }, { type: 'turn.started', turnId: 'new', ts: at(5000) }]);
    expect(await readLastAgentText(dir, 'task-1', at(6000))).toBeUndefined();
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBe('Parked question?');
  });
  it.each(['v2', 'v1'])('keeps the current %s question across its own completion', async version => {
    const dir = temp();
    const v2 = version === 'v2';
    history(dir, [{ type: 'text', text: 'Old question?' }, { type: 'turn-end' },
      ...(v2 ? [{ type: 'turn.started', turnId: 'new' }] : []),
      v2 ? message('Current question?') : { type: 'text', text: 'Current question?' },
      ...(v2 ? [{ type: 'turn.completed', turnId: 'new' }] : []),
      { type: 'turn-end' }, { type: 'note', message: 'Waiting for your answer' }]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBe('Current question?');
  });
  it('degrades to no excerpt for missing, corrupt or unsafe history', async () => {
    const dir = temp();
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBeUndefined();
    mkdirSync(join(dir, 'runs')); writeFileSync(join(dir, 'runs', 'task-1.ndjson'), '{broken\n\u0000\n');
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBeUndefined();
    expect(await readLastAgentText(dir, '../task-1', at(0))).toBeUndefined();
  });
  it('reads only the tail of a long transcript', async () => {
    const dir = temp();
    history(dir, [message('Too early'), ...Array.from({ length: 2000 }, () => ({ type: 'tool-result', result: 'x'.repeat(500) })), message('Tail question?')]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBe('Tail question?');
  });
  it('reads a finished run’s final message past a check step, never past a later user message', async () => {
    const dir = temp();
    history(dir, [{ type: 'user-message', text: 'do it' }, message('Last commit: feat x'), { type: 'turn.completed', turnId: 'agent' }, { type: 'turn-end' }, { type: 'step-start', stepId: 'check' }, { type: 'tool-result', result: 'ok' }]);
    expect(await readLastAgentText(dir, 'task-1', at(0))).toBeUndefined();
    expect(await readLastAgentText(dir, 'task-1', at(0), { boundary: 'message' })).toBe('Last commit: feat x');
    history(dir, [message('Older continuation'), { type: 'user-message', text: 'continue' }, { type: 'tool-result', result: 'x' }]);
    expect(await readLastAgentText(dir, 'task-1', at(0), { boundary: 'message' })).toBeUndefined();
  });
  it('keeps the head of a final reply, redacted, scrubbed and marker-free', () => {
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    const answer = agentAnswer('Last commit: feat x\nToken receiverSecretValue987654 in /home/me/private/file.ts\nCEZ:DONE', ['receiverSecretValue987654'])!;
    expect(answer.startsWith('Last commit: feat x')).toBe(true);
    expect(answer).not.toMatch(/receiverSecretValue987654|\/home\/me|CEZ:/);
    const long = agentAnswer(`${'start '.repeat(1000)}END`, [])!;
    expect(long.length).toBeLessThanOrEqual(4096);
    expect(long.startsWith('start start')).toBe(true); expect(long.endsWith('…')).toBe(true);
    expect(agentAnswer('CEZ:DONE', [])).toBeUndefined();
  });
  it('redacts secrets, scrubs paths, drops markers and keeps the bounded end on a boundary', () => {
    vi.stubEnv('CEZ_REDACT_SECRETS', '0');
    vi.stubEnv('TEST_WEBHOOK_SECRET', 'syntheticEnvironmentSecretValue123456');
    const text = `See /home/me/private/file.ts for details.\nToken syntheticEnvironmentSecretValue123456 and receiverSecretValue987654.\nCEZ:MONITORING\nShould I continue?`;
    const excerpt = agentExcerpt(text, ['receiverSecretValue987654'], value => value.replace('details', 'DETAILS'))!;
    expect(excerpt).not.toContain('syntheticEnvironmentSecretValue123456');
    expect(excerpt).not.toContain('receiverSecretValue987654');
    expect(excerpt).not.toContain('/home/me');
    expect(excerpt).not.toContain('CEZ:');
    expect(excerpt).toContain('Should I continue?');
    const long = agentExcerpt(`${'word '.repeat(300)}https://example.com/${'p'.repeat(80)} Final question?`, [])!;
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.startsWith('…')).toBe(true);
    expect(long.endsWith('Final question?')).toBe(true);
    const split = agentExcerpt(`https://example.com/${'q'.repeat(700)} tail?`, [])!;
    expect(split).toBe('…tail?');
    expect(agentExcerpt('CEZ:DONE', [])).toBeUndefined();
  });
});

describe('agent excerpt consent at admission', () => {
  it.each(['cezar.json.v1', 'slack.v1', 'discord.v1', 'telegram.v1'] as const)('keeps %s bytes identical without consent and never reads history', async format => {
    const dir = temp(), repository = await AdmissionRepository.open(dir, { now: () => now });
    const read = vi.fn(async () => 'Shall I push?');
    const settings = format === 'telegram.v1' ? telegram : format === 'slack.v1' ? { format, url: 'https://hooks.slack.com/services/T1/B1/x' }
      : format === 'discord.v1' ? { format, url: `https://discord.com/api/webhooks/${'1'.repeat(18)}/${'a'.repeat(68)}` } : {};
    const admitted = await repository.admit(source(), [receiver(settings), receiver({ ...settings, profile: 'minimal' }, '00000000-0000-4000-8000-000000000003')], read);
    expect(read).not.toHaveBeenCalled();
    for (const delivery of admitted!.deliveries) {
      const legacy = renderPayload(source(), delivery.profile, []);
      expect(delivery.body).toBe(legacy);
      expect(wire(format, delivery.body!)).toBe(wire(format, legacy));
    }
  });
  it('adds the excerpt only for a consenting Standard receiver of a prose question', async () => {
    const dir = temp(), repository = await AdmissionRepository.open(dir, { now: () => now });
    const read = vi.fn(async () => 'Shall I push <main> & tag @team?');
    const admitted = await repository.admit(source(), [receiver({ includeAgentExcerpt: true, ...telegram }), receiver({}, '00000000-0000-4000-8000-000000000003')], read);
    expect(read).toHaveBeenCalledTimes(1);
    const [consented, other] = admitted!.deliveries;
    expect(webhookEventSchema.parse(JSON.parse(consented!.body!))).toMatchObject({ data: { reason: 'turn_end', agentExcerpt: 'Shall I push <main> & tag @team?' } });
    expect(other!.body).toBe(renderPayload(source(), 'standard', []));
    const message = JSON.parse(renderTelegramMessage(consented!.body!, { chatId: '42' })).text as string;
    expect(message).toContain('Agent: Shall I push &lt;main&gt; &amp; tag @​team?');
    expect(renderSlackMessage(consented!.body!)).toContain('Shall I push &lt;main&gt; &amp; tag @team?');
    expect(renderDiscordMessage(consented!.body!)).toContain('"name":"Agent"');
  });
  it('never adds it to a structured question, and an extraction failure still delivers', async () => {
    const dir = temp(), repository = await AdmissionRepository.open(dir, { now: () => now });
    const read = vi.fn(async () => 'text');
    const question = await repository.admit(source(true), [receiver({ includeAgentExcerpt: true })], read);
    expect(read).not.toHaveBeenCalled();
    expect(question!.deliveries[0]!.body).toBe(renderPayload(source(true), 'standard', []));
    const failing = { ...source(), id: 'evt_00000000-0000-4000-8000-000000000003', sequence: 3 };
    const admitted = await repository.admit(failing, [receiver({ includeAgentExcerpt: true })], async () => { throw new Error('disk'); });
    expect(admitted!.deliveries[0]).toMatchObject({ status: 'pending', body: renderPayload(failing, 'standard', []) });
  });
  it('keeps Telegram inside the escaped-HTML limit with a dense excerpt', () => {
    const item = source(); item.snapshot.title = '<'.repeat(512);
    const body = renderPayload(item, 'standard', [], undefined, undefined, '<&>'.repeat(200));
    const text = JSON.parse(renderTelegramMessage(body, { chatId: '42', replyHint: true })).text as string;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('Agent: ');
  });
  it('requires Standard content for consent in the receiver contract', () => {
    const base = { name: 'Ops', url: 'https://example.com', includeAgentExcerpt: true };
    expect(createWebhookSchema.safeParse(base).success).toBe(false);
    expect(createWebhookSchema.safeParse({ ...base, profile: 'standard' }).success).toBe(true);
    expect(updateWebhookSchema.safeParse({ ...base, expectedRevision: 1 }).success).toBe(false);
    expect(createWebhookSchema.parse({ name: 'Ops', url: 'https://example.com' })).not.toHaveProperty('includeAgentExcerpt');
  });
});

describe('safeAgentText', () => {
  const slack = 'https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnopqrstuvwx';
  it.each(['excerpt', 'answer'] as const)('redacts every live receiver secret from the %s', async kind => {
    const dir = temp();
    history(dir, [message(`Done. Post to ${slack} next time.`)]);
    const receivers = () => [{ id: 'slack', format: 'slack.v1', url: slack } as PrivateReceiver];
    const text = await safeAgentText({ dataDir: dir, runId: 'task-1', until: at(0), kind, receivers });
    expect(text).toContain('Done.');
    expect(text).not.toContain('hooks.slack.com/services');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwx');
  });
});
