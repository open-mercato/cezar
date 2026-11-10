import { describe, expect, it } from 'vitest';
import { renderDiscordMessage } from './discord.ts';
const at = '2026-10-19T12:00:00Z';
function event(type: string, standard = false) {
  const data = type === 'task.attention_required' ? { episodeId: 'ep', since: at, reason: 'question', ...(standard ? { questions: [{ question: 'Which?', options: [{ label: 'Yes', description: 'Proceed' }] }] } : {}) }
    : type === 'task.review_ready' ? { episodeId: 'ep', since: at }
      : type === 'task.finished' ? { resolution: 'completed', finishedAt: at }
        : type === 'task.failed' ? { episodeId: 'ep', failedAt: at, disposition: 'manual', ...(standard ? { message: 'Failure detail' } : {}) } : { at };
  return { id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, sequence: 1,
    source: { instanceId: 'instance', projectId: 'project', mode: 'local' }, type,
    task: { id: 'abcdefgh-task', previousStatus: 'running', status: ({ 'task.attention_required': 'waiting', 'task.review_ready': 'review', 'task.finished': 'done', 'task.failed': 'failed', 'task.cancelled': 'cancelled' } as Record<string, string>)[type], ...(standard ? { title: 'Task title' } : {}) }, data };
}
describe('Discord rendering', () => {
  for (const [type, label] of Object.entries({ 'task.attention_required': 'Needs your input', 'task.review_ready': 'Ready for review', 'task.finished': 'Task finished', 'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled' })) {
    for (const standard of [false, true]) it(`${type} ${standard ? 'standard' : 'minimal'}`, () => {
      const result = JSON.parse(renderDiscordMessage(JSON.stringify(event(type, standard))));
      expect(result.content).toBe(`${label} · ${standard ? 'Task title' : 'abcdefgh'}`);
      expect(result.allowed_mentions).toEqual({ parse: [] });
      expect(result.embeds[0].timestamp).toBe(at);
      expect(JSON.stringify(result).includes('Which?')).toBe(standard && type === 'task.attention_required');
      expect(JSON.stringify(result).includes('Failure detail')).toBe(standard && type === 'task.failed');
      expect(JSON.stringify(result)).not.toContain('instance');
    });
  }
  it('neutralizes mentions and markdown, including masked links', () => {
    const value = event('task.finished', true);
    value.task.title = '@everyone <@123> <@&123> *bold* [trusted](https://evil.test)\n# header\n- item';
    const result = JSON.parse(renderDiscordMessage(JSON.stringify(value)));
    expect(result.content).toContain('@\u200beveryone');
    expect(result.content).toContain('<@\u200b123\\>');
    expect(result.content).toContain('\\*bold\\*');
    expect(result.content).toContain('\\[trusted\\]\\(<https://evil.test>\\)');
    expect(result.content).toContain('\\# header');
    expect(result.content).toContain('\\- item');
    expect(result.allowed_mentions).toEqual({ parse: [] });
  });
  it('bounds every field and the aggregate embed text', () => {
    for (const type of ['task.attention_required', 'task.failed']) {
      const value = event(type, true); value.task.title = '*'.repeat(512);
      if (type === 'task.attention_required') Object.assign(value.data, { questions: Array.from({ length: 20 }, () => ({ question: '*'.repeat(2000), options: Array.from({ length: 10 }, () => ({ label: '*'.repeat(120), description: '*'.repeat(500) })) })) });
      else Object.assign(value.data, { message: '*'.repeat(4000) });
      const result = JSON.parse(renderDiscordMessage(JSON.stringify(value)));
      expect(result.content.length).toBeLessThanOrEqual(2000);
      const embed = result.embeds[0];
      expect(embed.title.length).toBeLessThanOrEqual(256);
      expect((embed.description ?? '').length).toBeLessThanOrEqual(4096);
      expect(embed.fields.length).toBeLessThanOrEqual(25);
      let length = embed.title.length + (embed.description ?? '').length + embed.footer.text.length;
      for (const field of embed.fields) { expect(field.value.length).toBeLessThanOrEqual(1024); length += field.name.length + field.value.length; }
      expect(length).toBeLessThanOrEqual(6000);
    }
  });
  it('uses only supplied links and never invents a local cockpit URL', () => {
    const value = event('task.finished');
    expect(JSON.parse(renderDiscordMessage(JSON.stringify(value))).embeds[0].url).toBeUndefined();
    Object.assign(value, { links: { cockpit: 'https://cockpit.example/task', issue: 'https://github.com/acme/repo/issues/1', pullRequest: 'https://github.com/acme/repo/pull/2' } });
    expect(JSON.parse(renderDiscordMessage(JSON.stringify(value))).embeds[0].url).toBe('https://github.com/acme/repo/pull/2');
    Object.assign(value, { links: { cockpit: 'https://cockpit.example/task' } });
    expect(JSON.parse(renderDiscordMessage(JSON.stringify(value))).embeds[0].url).toBeUndefined();
    value.source.mode = 'hosted';
    expect(JSON.parse(renderDiscordMessage(JSON.stringify(value))).embeds[0].url).toBe('https://cockpit.example/task');
  });
  it('renders a named test with mentions disabled', () => {
    const result = JSON.parse(renderDiscordMessage(JSON.stringify({ id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } }), { receiverName: '@everyone' }));
    expect(result.content).toContain('cezar is connected to this channel');
    expect(result.content).toContain('@\u200beveryone'); expect(result.allowed_mentions).toEqual({ parse: [] });
  });
});

it('suppresses content URL previews without escaping URL syntax', () => {
  const value = event('task.finished', true);
  value.task.title = 'See https://example.test/a_b?q=x*y&user=@someone and <https://example.test/next>';
  const result = JSON.parse(renderDiscordMessage(JSON.stringify(value)));
  expect(result.content).toContain('<https://example.test/a_b?q=x*y&user=@someone>');
  expect(result.content).toContain('<https://example.test/next>');
  expect(result.allowed_mentions).toEqual({ parse: [] });
  expect(result.content.length).toBeLessThanOrEqual(2000);
});

it('never truncates a suppression wrapper or exceeds the content limit', () => {
  const test = JSON.stringify({ id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1,
    occurredAt: at, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } });
  for (const count of [1900, 1946, 1950, 2000]) {
    const result = JSON.parse(renderDiscordMessage(test, { receiverName: 'a'.repeat(count) + ' https://example.test/' + 'x'.repeat(100) }));
    expect(result.content.length).toBeLessThanOrEqual(2000);
    expect(result.content).not.toContain('https://');
  }
  const result = JSON.parse(renderDiscordMessage(test, { receiverName: 'https://example.test/a_b' }));
  expect(result.content).toContain('<https://example.test/a_b>');
});

// Exercise both contentText callers: task titles and test receiver names.
it.each([
  ['[a](https://a.test)[b](https://b.test)', String.raw`\[a\]\(<https://a.test>\)\[b\]\(<https://b.test>\)`],
  ['https://en.wikipedia.org/wiki/Function_(mathematics)', '<https://en.wikipedia.org/wiki/Function_(mathematics)>'],
  ['http://[2001:db8::1]/health', '<http://[2001:db8::1]/health>'],
  ['https://example.test/search?q=[foo]', '<https://example.test/search?q=[foo]>'],
  ['(https://example.test/a_(b(c)))', String.raw`\(<https://example.test/a_(b(c))>\)`],
  ['[https://example.test/search?q=[foo]]', String.raw`\[<https://example.test/search?q=[foo]>\]`],
  ['[trusted](https://example.test/a_(b))', String.raw`\[trusted\]\(<https://example.test/a_(b)>\)`],
  ['<https://example.test/a_(b)?q=[foo]>', '<https://example.test/a_(b)?q=[foo]>'],
  ['(http://[::1]/health) @everyone', String.raw`\(<http://[::1]/health>\) @` + '\u200beveryone'],
])('preserves complete URL targets and surrounding delimiters: %s', (input, expected) => {
  const value = event('task.finished', true);
  value.task.title = input;
  const task = JSON.parse(renderDiscordMessage(JSON.stringify(value)));
  const test = JSON.parse(renderDiscordMessage(JSON.stringify({ id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1,
    occurredAt: at, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } }), { receiverName: input }));
  expect(task.content).toBe(`Task finished · ${expected}`);
  expect(test.content).toBe(`Test message · cezar is connected to this channel · ${expected}`);
  for (const result of [task, test]) expect(result.allowed_mentions).toEqual({ parse: [] });
});

it('drops a complete balanced URL atomically when only its prefix fits', () => {
  const test = JSON.stringify({ id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1,
    occurredAt: at, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } });
  const result = JSON.parse(renderDiscordMessage(test, { receiverName: 'a'.repeat(1900) + ' https://example.test/(' + 'x'.repeat(100) + ')' }));
  expect(result.content.length).toBeLessThanOrEqual(2000);
  expect(result.content).not.toContain('https://');
  expect(result.content).toMatch(/…$/);
});
