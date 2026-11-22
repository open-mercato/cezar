import { describe, expect, it } from 'vitest';
import type { ManagerMessage, QuestionItem } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { buildAttentionList, phoneBadgeCount, type AttentionSources } from './list.ts';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const run = (id: string, patch: Partial<RunRecord>): RunRecord => ({
  id, title: `Task ${id}`, workflow: 'quick-task', task: 't', steps: [], status: 'running',
  createdAt: ago(60), ...patch,
} as unknown as RunRecord);

const question = (key: string, patch: Partial<QuestionItem> = {}): QuestionItem => ({
  key,
  source: { kind: 'manager', managerId: 'mgr', name: 'Shop manager' },
  askedAt: ago(5),
  questions: [{ header: 'API', question: 'Which API?', options: [{ label: 'REST' }, { label: 'GraphQL' }] }],
  older: false,
  ...patch,
});

const action = (id: string): Extract<ManagerMessage, { kind: 'action' }> => ({
  id, seq: 1, at: ago(10), kind: 'action', status: 'pending',
  action: { type: 'merge-pr', projectId: 'app', number: 12 },
} as unknown as Extract<ManagerMessage, { kind: 'action' }>);

const sources = (patch: Partial<AttentionSources> = {}): AttentionSources => ({
  questions: [],
  managers: [{ id: 'mgr', name: 'Shop manager', important: 0 }],
  approvals: [],
  projects: [],
  now: NOW,
  ...patch,
});

describe('buildAttentionList', () => {
  it('lists every kind, each with the manager or project it belongs to', () => {
    const list = buildAttentionList(sources({
      questions: [question('m:mgr:q1')],
      approvals: [{ managerId: 'mgr', message: action('a1'), title: 'Merge of app#12' }],
      managers: [{ id: 'mgr', name: 'Shop manager', important: 2, headline: 'Deploy is blocked', lastActivityAt: ago(1) }],
      projects: [{ id: 'app', runs: [
        run('wait', { status: 'waiting', waitingSince: ago(3) }),
        run('rev', { status: 'review', finishedAt: ago(4) }),
        run('bad', { status: 'failed', finishedAt: ago(2) }),
        run('busy', { status: 'running', startedAt: ago(1) }),
      ] }],
    }));
    expect(list.items.map((item) => [item.kind, item.managerName ?? item.projectId])).toEqual([
      ['question', 'Shop manager'],
      ['approval', 'Shop manager'],
      ['task', 'app'],
      ['review', 'app'],
      ['failed', 'app'],
      ['message', 'Shop manager'],
    ]);
    expect(list.items[0]).toMatchObject({ questionKey: 'm:mgr:q1', options: ['REST', 'GraphQL'], header: 'API' });
    expect(list.items[1]).toMatchObject({ actionId: 'a1', title: 'Merge of app#12' });
    expect(list.items.at(-1)).toMatchObject({ title: 'Deploy is blocked', detail: '2 important messages' });
    // Failed tasks show but do not count (owner decision 2026-11-20).
    expect(list.counts).toEqual({ total: 5, question: 1, approval: 1, task: 1, review: 1, failed: 1, message: 1 });
  });

  it('shows a task that asked a question once, as the question', () => {
    const list = buildAttentionList(sources({
      questions: [question('r:app:wait:req', { source: { kind: 'task', projectId: 'app', runId: 'wait', title: 'Task wait', status: 'waiting' } })],
      projects: [{ id: 'app', runs: [run('wait', { status: 'waiting', waitingSince: ago(3) })] }],
    }));
    expect(list.items.map((item) => item.kind)).toEqual(['question']);
    expect(list.items[0]).toMatchObject({ projectId: 'app', runId: 'wait' });
  });

  it('leaves out Older and closed questions, and an inactive manager’s cards and messages', () => {
    const list = buildAttentionList(sources({
      questions: [question('m:mgr:old', { older: true }), question('m:off:q', { source: { kind: 'manager', managerId: 'off', name: 'Off' } })],
      managers: [{ id: 'mgr', name: 'Shop manager', important: 0 }, { id: 'off', name: 'Off', important: 3, inactive: { since: ago(100) } }],
    }));
    expect(list.items).toEqual([]);
    expect(list.counts.total).toBe(0);
  });

  it('shows a muted manager’s items without counting them', () => {
    const list = buildAttentionList(sources({
      questions: [question('m:mgr:q1')],
      managers: [{ id: 'mgr', name: 'Shop manager', important: 1, notify: false }],
    }));
    expect(list.items.map((item) => [item.kind, item.counted])).toEqual([['question', false], ['message', false]]);
    expect(list.counts.total).toBe(0);
    expect(phoneBadgeCount(list.items, ['question', 'message'])).toBe(0);
  });

  it('moves its revision when the list changes, and only then', () => {
    const one = buildAttentionList(sources({ questions: [question('m:mgr:q1')] }));
    expect(buildAttentionList(sources({ questions: [question('m:mgr:q1')] })).revision).toBe(one.revision);
    expect(buildAttentionList(sources({ questions: [question('m:mgr:q2')] })).revision).not.toBe(one.revision);
  });
});

describe('phoneBadgeCount', () => {
  it('counts the kinds a phone chose; failed tasks only when it chose them', () => {
    const { items } = buildAttentionList(sources({
      questions: [question('m:mgr:q1')],
      projects: [{ id: 'app', runs: [run('rev', { status: 'review', finishedAt: ago(4) }), run('bad', { status: 'failed', finishedAt: ago(2) })] }],
    }));
    expect(phoneBadgeCount(items, ['question', 'review'])).toBe(2);
    expect(phoneBadgeCount(items, ['question'])).toBe(1);
    expect(phoneBadgeCount(items, ['failed'])).toBe(1);
    expect(phoneBadgeCount(items, [])).toBe(0);
  });
});
