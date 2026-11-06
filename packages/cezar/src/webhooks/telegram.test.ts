import { describe, expect, it } from 'vitest';
import { formatTelegramText, renderTelegramMessage } from './telegram.ts';
const at = '2026-10-27T12:00:00Z';
function event(type: string, standard = false) {
  const data = type === 'task.attention_required' ? { episodeId: 'ep', since: at, reason: 'question', ...(standard ? { questions: [{ question: 'Which?', options: [{ label: 'Yes', description: 'Proceed' }] }] } : {}) }
    : type === 'task.review_ready' ? { episodeId: 'ep', since: at }
      : type === 'task.finished' ? { resolution: 'completed', finishedAt: at }
        : type === 'task.failed' ? { episodeId: 'ep', failedAt: at, disposition: 'manual', ...(standard ? { message: 'Failure detail' } : {}) } : { at };
  return { id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, sequence: 1,
    source: { instanceId: 'instance', projectId: 'project', mode: 'local' }, type,
    task: { id: 'abcdefgh-task', previousStatus: 'running', status: ({ 'task.attention_required': 'waiting', 'task.review_ready': 'review', 'task.finished': 'done', 'task.failed': 'failed', 'task.cancelled': 'cancelled' } as Record<string, string>)[type], ...(standard ? { title: 'Task title' } : {}) }, data } as Record<string, any>;
}
const render = (value: unknown, chatId = '-1001234567890') => JSON.parse(renderTelegramMessage(JSON.stringify(value), { chatId }));

describe('Telegram rendering', () => {
  for (const [type, label] of Object.entries({ 'task.attention_required': 'Task needs your input', 'task.review_ready': 'Task ready for review', 'task.finished': 'Task completed', 'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled' })) {
    for (const standard of [false, true]) it(`${type} ${standard ? 'standard' : 'minimal'}`, () => {
      const result = render(event(type, standard));
      expect(result).toMatchObject({ chat_id: '-1001234567890', parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      expect(result.text.startsWith(`<b>${label}</b> · ${standard ? 'Task title' : 'abcdefgh'}`)).toBe(true);
      expect(result.text.includes('Which?')).toBe(standard && type === 'task.attention_required');
      expect(result.text.includes('Failure detail')).toBe(standard && type === 'task.failed');
      expect(result.text).not.toContain('instance');
    });
  }
  it('renders the connection test with the receiver name', () => {
    const result = JSON.parse(renderTelegramMessage(JSON.stringify({ id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } }), { chatId: '@cezar_alerts', receiverName: '@everyone <b>' }));
    expect(result).toMatchObject({ chat_id: '@cezar_alerts', text: '<b>Test message</b> · cezar is connected to this chat · @\u200beveryone &lt;b&gt;' });
  });
  it('escapes HTML and neutralizes mentions in task text', () => {
    const value = event('task.failed', true);
    value.task.title = '<b>bold</b> & <a href="https://evil.test">x</a> @everyone';
    value.data.message = '</code><script>';
    const { text } = render(value);
    expect(text).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; &lt;a href="https://evil.test"&gt;x&lt;/a&gt; @​everyone');
    expect(text).toContain('Error: &lt;/code&gt;&lt;script&gt;');
    expect(text).not.toContain('<script>');
  });
  it('links pull requests, and the cockpit only when hosted', () => {
    const linked = event('task.review_ready', true); linked.links = { pullRequest: 'https://github.com/o/r/pull/1?a=1&b=2' };
    expect(render(linked).text).toContain('<a href="https://github.com/o/r/pull/1?a=1&amp;b=2">Open pull request</a>');
    const local = event('task.review_ready', true); local.links = { cockpit: 'https://cezar.example/p/x' };
    expect(render(local).text).not.toContain('<a ');
    local.source.mode = 'hosted';
    expect(render(local).text).toContain('<a href="https://cezar.example/p/x">Open in cezar</a>');
  });
  it('keeps the escaped HTML within 4096 characters, dropping trailing questions first', () => {
    const value = event('task.attention_required', true);
    value.task.title = '<'.repeat(512);
    value.data.questions = Array.from({ length: 20 }, (_, index) => ({ question: `Q${index} ${'&'.repeat(1990)}`, options: Array.from({ length: 10 }, () => ({ label: '>'.repeat(100), description: '<'.repeat(400) })) }));
    const { text } = render(value);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('1. Q0');
    expect(text).not.toContain('Q19');
    expect(text).not.toMatch(/&[a-z]*…|<[^>]*…/);
  });
  it('clips content before dropping the reply hint or its link near the Telegram limit', () => {
    const value = event('task.attention_required', true);
    value.task.title = 'x'.repeat(256);
    value.source.projectId = 'p'.repeat(128);
    value.task.id = 'i'.repeat(128);
    value.data.questions = [{ question: 'q'.repeat(2000), options: Array.from({ length: 3 }, () => ({ label: 'l'.repeat(100), description: 'd'.repeat(400) })) }];
    value.links = { issue: 'https://github.com/open-mercato/cezar/issues/123' };
    const result = JSON.parse(renderTelegramMessage(JSON.stringify(value), { chatId: '456', replyHint: true }));
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.text).toContain('1. ');
    expect(result.text).toContain('<a href="https://github.com/open-mercato/cezar/issues/123">Open issue</a>');
    expect(result.text).toContain('Reply to this message');
  });
  it('shows the Reply hint only when the caller says two-way Telegram is active', () => {
    const value = event('task.attention_required', true);
    expect(render(value).text).not.toContain('Reply to this message');
    const group = JSON.parse(renderTelegramMessage(JSON.stringify(value), { chatId: '-100', replyHint: true })).text;
    expect(group).toContain('Reply to this message to answer the task.'); expect(group).not.toContain('/reply');
    expect(JSON.parse(renderTelegramMessage(JSON.stringify(value), { chatId: '456', replyHint: true })).text).toContain('or just type your answer here');
  });
  it('names statuses for people instead of lifecycle codes', () => {
    const { text } = render(event('task.finished'));
    expect(text).toContain('Status: Completed (was running)'); expect(text).not.toContain('→');
  });
  it('keeps this bot\'s addressed commands clickable while neutralizing other mentions', () => {
    expect(formatTelegramText('/tasks@test_bot or @everyone /x@other_bot', 4096, 'test_bot')).toBe('/tasks@test_bot or @\u200beveryone /x@\u200bother_bot');
    expect(formatTelegramText('/tasks@test_botx', 4096, 'test_bot')).toBe('/tasks@\u200btest_botx');
  });
  it('fails closed without a chat ID', () => {
    expect(() => renderTelegramMessage(JSON.stringify(event('task.finished')), { chatId: '' })).toThrow('chat ID');
  });
});
