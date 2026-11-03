import { expect, it } from 'vitest';
import { renderTelegramMessage, renderTelegramTaskReply, type TelegramTaskReply } from './telegram.ts';

// Goldens for both Telegram notice paths: one layout feeds both, so wording cannot drift.
const at = '2026-10-27T12:00:00Z';
const status: Record<string, string> = { 'task.attention_required': 'waiting', 'task.review_ready': 'review', 'task.finished': 'done', 'task.failed': 'failed', 'task.cancelled': 'cancelled' };
function event(type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const base = type === 'task.attention_required' ? { episodeId: 'ep', since: at, reason: 'question' }
    : type === 'task.review_ready' ? { episodeId: 'ep', since: at }
      : type === 'task.finished' ? { resolution: 'completed', finishedAt: at }
        : type === 'task.failed' ? { episodeId: 'ep', failedAt: at, disposition: 'manual' } : { at };
  return { id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, sequence: 1,
    source: { instanceId: 'instance', projectId: 'project', mode: 'local' }, type,
    task: { id: 'abcdefgh-task', previousStatus: 'running', status: status[type], title: 'Fix the login test' }, data: { ...base, ...data }, ...extra };
}
const questions = [{ question: 'Which database?', options: [{ label: 'Postgres', description: 'the default' }, { label: 'SQLite' }] }, { question: 'Ship it <today> & @all?' }];
const heavy = '<div class="a">&</div>\n'.repeat(400);
const webhook: Array<[string, ReturnType<typeof event> | Record<string, unknown>, { chatId: string; receiverName?: string; replyHint?: boolean }]> = [
  ['waiting questions private hint', event('task.attention_required', { questions }), { chatId: '456', replyHint: true }],
  ['waiting questions group hint', event('task.attention_required', { questions }), { chatId: '-100', replyHint: true }],
  ['waiting questions no hint', event('task.attention_required', { questions }), { chatId: '456' }],
  ['waiting excerpt private hint', event('task.attention_required', { agentExcerpt: 'I need the <API> key & a decision.' }), { chatId: '456', replyHint: true }],
  ['finished', event('task.finished'), { chatId: '456' }],
  ['finished unchanged', event('task.finished', { resolution: 'no_changes' }), { chatId: '456' }],
  ['review with pull request', event('task.review_ready', {}, { links: { pullRequest: 'https://github.com/o/r/pull/1?a=1&b=2' } }), { chatId: '456' }],
  ['failed with error', event('task.failed', { message: 'Build <failed> & @here' }), { chatId: '-100' }],
  ['cancelled hosted cockpit', event('task.cancelled', {}, { source: { instanceId: 'i', projectId: 'project', mode: 'hosted' }, links: { cockpit: 'https://cezar.example/p/x' } }), { chatId: '456' }],
  ['failed html heavy', event('task.failed', { message: heavy.slice(0, 4000) }, { task: { id: 'abcdefgh-task', previousStatus: 'running', status: 'failed', title: '<'.repeat(300) } }), { chatId: '456' }],
  ['waiting long questions', event('task.attention_required', { questions: Array.from({ length: 20 }, (_, index) => ({ question: `Q${index} ${'&'.repeat(1990)}`, options: Array.from({ length: 10 }, () => ({ label: '>'.repeat(100), description: '<'.repeat(400) })) })) }), { chatId: '456', replyHint: true }],
  ['waiting near limit with issue', event('task.attention_required', { questions: [{ question: 'q'.repeat(2000), options: Array.from({ length: 3 }, () => ({ label: 'l'.repeat(100), description: 'd'.repeat(400) })) }] },
    { source: { instanceId: 'i', projectId: 'p'.repeat(128), mode: 'local' }, task: { id: 'i'.repeat(128), previousStatus: 'running', status: 'waiting', title: 'x'.repeat(256) }, links: { issue: 'https://github.com/open-mercato/cezar/issues/123' } }), { chatId: '456', replyHint: true }],
  ['connection test', { id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } }, { chatId: '@alerts', receiverName: 'Ops <team>' }],
];
const base = { id: 'abcdefgh-task', title: 'Fix the login test' };
const runtime: Array<[string, TelegramTaskReply]> = [
  ['waiting questions private', { ...base, status: 'waiting', privateChat: true, questions }],
  ['waiting questions group', { ...base, status: 'waiting', privateChat: false, questions }],
  ['waiting questions not replyable', { ...base, status: 'waiting', privateChat: true, questions, replyable: false }],
  ['waiting excerpt private', { ...base, status: 'waiting', privateChat: true, excerpt: 'I need the <API> key & a decision.' }],
  ['done answer and result', { ...base, status: 'done', privateChat: true, result: 'Pull request opened', answer: 'Last commit: <feat> & @all', links: { pullRequest: 'https://github.com/o/r/pull/1' } }],
  ['done long answer', { ...base, status: 'done', privateChat: true, answer: 'word '.repeat(2000), links: { pullRequest: 'https://github.com/o/r/pull/1' } }],
  ['review answer', { ...base, status: 'review', privateChat: true, answer: 'Ready, see the diff.' }],
  ['failed error group', { ...base, status: 'failed', error: 'Build <failed> & @here' }],
  ['cancelled', { ...base, status: 'cancelled' }],
  ['expired', { ...base, status: 'expired' }],
  ['running', { ...base, status: 'running' }],
  ['done html heavy with long link', { ...base, status: 'done', result: heavy, links: { pullRequest: 'https://example.test/' + 'p'.repeat(600) } }],
  ['waiting html heavy question private', { ...base, status: 'waiting', privateChat: true, questions: [{ question: heavy }, { question: 'second' }] }],
];

/** Repeated runs fold to `⟪unit⟫×n`, so a 4096-character notice stays reviewable as a diff. */
const fold = (text: string) => text.replace(/(.{1,48}?)\1{7,}/gs, (run, unit: string) => `⟪${unit}⟫×${run.length / unit.length}`);
const block = (name: string, text: string) => `### ${name} (${text.length} chars)\n${fold(text)}\n`;

it('pins the rendered Telegram notices of both paths', async () => {
  const rendered: Array<[string, string]> = [
    ...webhook.map(([name, value, ctx]): [string, string] => [`webhook: ${name}`, JSON.parse(renderTelegramMessage(JSON.stringify(value), ctx)).text]),
    ...runtime.map(([name, reply]): [string, string] => [`runtime: ${name}`, renderTelegramTaskReply(reply)]),
  ];
  // Both paths budget the escaped HTML, so neither can exceed what the dispatcher accepts.
  for (const [, text] of rendered) expect(text.length).toBeLessThanOrEqual(4096);
  await expect(rendered.map(([name, text]) => block(name, text)).join('\n')).toMatchFileSnapshot('./__goldens__/telegram-notices.txt');
});
