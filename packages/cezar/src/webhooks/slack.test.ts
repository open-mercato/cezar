import { describe, expect, it } from 'vitest';
import { renderSlackMessage } from './slack.ts';
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
describe('Slack rendering', () => {
  for (const [type, label] of Object.entries({ 'task.attention_required': 'Needs your input', 'task.review_ready': 'Ready for review', 'task.finished': 'Task finished', 'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled' })) {
    for (const standard of [false, true]) it(`${type} ${standard ? 'standard' : 'minimal'}`, () => {
      const result = JSON.parse(renderSlackMessage(JSON.stringify(event(type, standard))));
      expect(result.text).toBe(`${label} · ${standard ? 'Task title' : 'abcdefgh'} · project`);
      expect(JSON.stringify(result)).toContain('running →');
      expect(JSON.stringify(result).includes('Which?')).toBe(standard && type === 'task.attention_required');
      expect(JSON.stringify(result).includes('Failure detail')).toBe(standard && type === 'task.failed');
      expect(JSON.stringify(result)).not.toContain('instance');
    });
  }
  it('escapes untrusted text and disables automatic parsing', () => {
    const value = event('task.finished', true); value.task.title = '<!channel> & <@123>';
    const result = JSON.parse(renderSlackMessage(JSON.stringify(value)));
    expect(result.text).toContain('&lt;!channel&gt; &amp; &lt;@');
    expect(result.blocks[0].text.verbatim).toBe(true);
    expect(result.link_names).toBe(false);
  });
  it('clips oversized question lists and keeps the body bounded', () => {
    const value = event('task.attention_required', true);
    Object.assign(value.data, { questions: Array.from({ length: 20 }, () => ({ question: '&'.repeat(2000), options: [{ label: 'x'.repeat(120), description: '😀'.repeat(250) }] })) });
    const result = renderSlackMessage(JSON.stringify(value));
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(40_000);
    for (const block of JSON.parse(result).blocks) if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(2900);
  });
  it('preserves validated links without allowing link delimiters to inject markup', () => {
    const value = event('task.finished');
    Object.assign(value, { links: { issue: 'https://example.com/issues/1?q=a|b', cockpit: 'https://cockpit.example/task' } });
    const local = renderSlackMessage(JSON.stringify(value));
    expect(local).toContain('https://example.com/issues/1?q=a%7Cb|Issue');
    expect(local).not.toContain('cockpit.example');
    value.source.mode = 'hosted';
    expect(renderSlackMessage(JSON.stringify(value))).toContain('cockpit.example/task|Open in cezar');
  });
  it('keeps a supplied user title under minimal without inventing optional details', () => {
    const value = event('task.attention_required'); value.task.title = 'User title';
    const result = renderSlackMessage(JSON.stringify(value));
    expect(result).toContain('User title'); expect(result).not.toContain('Which?');
    expect(result).not.toContain('Failure detail'); expect(result).not.toContain('https://');
  });
  it('renders a named test without task data', () => {
    const result = renderSlackMessage(JSON.stringify({ id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, type: 'webhook.test', data: { test: true, format: 'cezar.json.v1' } }), { receiverName: 'My channel' });
    expect(result).toContain('cezar is connected to this channel'); expect(result).toContain('My channel');
  });
});
