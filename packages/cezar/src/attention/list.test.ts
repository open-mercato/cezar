import { describe, expect, it } from 'vitest';
import type { ManagerMessage, QuestionItem } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { buildAttentionList, currentTaskPr, managerNeedsYou, phoneBadgeCount, type AttentionSources, type PrEnd } from './list.ts';

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
    // Blocking decisions first, then the review gate, then waits, then failures.
    expect(list.items.map((item) => [item.kind, item.managerName ?? item.projectId])).toEqual([
      ['approval', 'Shop manager'],
      ['question', 'Shop manager'],
      ['message', 'Shop manager'],
      ['review', 'app'],
      ['task', 'app'],
      ['failed', 'app'],
    ]);
    expect(list.items[1]).toMatchObject({ questionKey: 'm:mgr:q1', options: ['REST', 'GraphQL'], header: 'API' });
    expect(list.items[0]).toMatchObject({ actionId: 'a1', title: 'Merge of app#12' });
    expect(list.items[2]).toMatchObject({ title: 'Deploy is blocked', detail: '2 important messages' });
    expect(list.overrides).toEqual([]);
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

  it('leaves out closed questions, and an inactive manager’s cards and messages', () => {
    const list = buildAttentionList(sources({
      questions: [question('m:mgr:shut', { closed: { reason: 'answered', at: ago(1) } }), question('m:off:q', { source: { kind: 'manager', managerId: 'off', name: 'Off' } })],
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

describe('probably done (spec 2026-11-23-needs-you-triage)', () => {
  const DAY = 24 * 60;

  it('lists a question flagged stale as probably done, uncounted and last', () => {
    const list = buildAttentionList(sources({
      questions: [
        question('m:mgr:stale', { askedAt: ago(1), stale: { why: 'mentioned-work-ended', detail: 'PR #2428 it mentions was merged', since: ago(1) } }),
        question('m:mgr:live', { askedAt: ago(30) }),
        question('m:mgr:chat', { askedAt: ago(2), stale: { why: 'replied-in-chat', detail: 'you replied 4m after it was asked', since: ago(1) } }),
      ],
    }));
    expect(list.items.map((item) => [item.key, item.settled?.why, item.counted])).toEqual([
      ['question:m:mgr:live', undefined, true],
      ['question:m:mgr:stale', 'work-ended', true],
      ['question:m:mgr:chat', 'overtaken', true],
    ]);
    expect(list.items[1]!.settled!.detail).toBe('PR #2428 it mentions was merged');
    expect(list.counts).toMatchObject({ total: 1, question: 1 });
  });

  it('folds an Older question and a paused task quiet past the Older days', () => {
    const list = buildAttentionList(sources({
      olderAfterDays: 3,
      questions: [question('m:mgr:old', { older: true, askedAt: ago(4 * DAY) })],
      projects: [{ id: 'app', runs: [
        run('old', { status: 'waiting', waitingSince: ago(4 * DAY) }),
        run('new', { status: 'waiting', waitingSince: ago(2 * DAY) }),
      ] }],
    }));
    expect(list.items.map((item) => [item.runId ?? item.key, item.settled?.detail])).toEqual([
      ['new', undefined],
      // The age itself, never the threshold.
      ['question:m:mgr:old', 'Quiet for 4 days'],
      ['old', 'Quiet for 4 days'],
    ]);
    expect(list.counts.total).toBe(1);
  });

  it('never folds a task for age when Older is off', () => {
    const list = buildAttentionList(sources({ olderAfterDays: 0, projects: [{ id: 'app', runs: [run('old', { status: 'waiting', waitingSince: ago(40 * DAY) })] }] }));
    expect(list.items[0]!.settled).toBeUndefined();
  });

  it('folds a paused task, and its question, once its own PR merged or closed', () => {
    const list = buildAttentionList(sources({
      questions: [question('r:app:asks:req', { source: { kind: 'task', projectId: 'app', runId: 'asks', title: 'Task asks', status: 'waiting' } })],
      projects: [{ id: 'app', runs: [
        run('merged', { status: 'waiting', waitingSince: ago(3), markerRefs: { pr: 2317 } }),
        run('asks', { status: 'waiting', waitingSince: ago(3), pullRequestUrl: 'https://github.com/o/r/pull/9' }),
        run('open', { status: 'review', finishedAt: ago(4), markerRefs: { pr: 5 } }),
      ] }],
      prEnded: (_projectId, r) => (r.id === 'merged' ? { number: 2317, state: 'merged', endedAt: ago(1) } : r.id === 'asks' ? { number: 9, state: 'closed', endedAt: ago(1) } : undefined),
    }));
    expect(list.items.map((item) => [item.runId, item.kind, item.settled?.detail])).toEqual([
      ['open', 'review', undefined],
      ['asks', 'question', 'PR #9 closed'],
      ['merged', 'task', 'PR #2317 merged'],
    ]);
    expect(list.items[1]!.settled!.why).toBe('pr-closed');
    expect(phoneBadgeCount(list.items, ['question', 'task', 'review'])).toBe(1);
  });

  it('folds a question card once its declared or mentioned PR merged or closed', () => {
    const card = (key: string, text: string, patch: Partial<QuestionItem> = {}) =>
      question(key, { questions: [{ header: 'Merge', question: text, options: [{ label: 'Yes' }, { label: 'No' }] }], ...patch });
    const states: Record<string, PrEnd> = {
      'cezar/2428': { state: 'merged', endedAt: ago(1) },
      'app/7': { state: 'closed', endedAt: ago(1) },
      'app/8': { state: 'merged', endedAt: ago(1) },
    };
    const list = buildAttentionList(sources({
      questions: [
        card('m:mgr:mention', 'Earlier reviews of [[pr:cezar/2428]] read nothing. How now?'),
        card('m:mgr:about', 'Merge it?', { about: [{ pr: 7 }, { task: 'app/r1' }] }),
        card('m:mgr:source', 'Ship it?', { about: [{ pr: 8 }], sourceTasks: [{ projectId: 'app', runId: 'r2' }] }),
        card('m:mgr:open', 'Review [[pr:cezar/5]]?', { about: [{ pr: 5 }] }),
        // A bare declared PR with no project to look it up in stays open.
        card('m:mgr:nowhere', 'Merge #8?', { about: [{ pr: 8 }] }),
      ],
      prState: (projectId, number) => states[`${projectId}/${number}`],
    }));
    const settled = Object.fromEntries(list.items.map((item) => [item.key, item.settled]));
    expect(settled['question:m:mgr:mention']).toEqual({ why: 'pr-merged', detail: 'PR #2428 it mentions was merged' });
    expect(settled['question:m:mgr:about']).toEqual({ why: 'pr-closed', detail: 'PR #7 closed' });
    expect(settled['question:m:mgr:source']).toEqual({ why: 'pr-merged', detail: 'PR #8 merged' });
    expect(settled['question:m:mgr:open']).toBeUndefined();
    expect(settled['question:m:mgr:nowhere']).toBeUndefined();
    expect(list.counts.total).toBe(2);
  });

  it('sorts an item past half the quiet threshold below fresh ones of its kind', () => {
    const list = buildAttentionList(sources({
      olderAfterDays: 4,
      questions: [
        question('m:mgr:old', { askedAt: ago(3 * DAY) }),
        question('m:mgr:new', { askedAt: ago(4 * DAY - 1) }),
      ],
      approvals: [{ managerId: 'mgr', message: { ...action('a1'), at: ago(3 * DAY) }, title: 'Merge' }],
    }));
    // All three are past half of 4 days: approvals before questions, then newest first.
    expect(list.items.map((item) => item.key)).toEqual(['approval:mgr:a1', 'question:m:mgr:old', 'question:m:mgr:new']);
    const mixed = buildAttentionList(sources({
      olderAfterDays: 4,
      questions: [question('m:mgr:fresh', { askedAt: ago(DAY) })],
      approvals: [{ managerId: 'mgr', message: { ...action('a1'), at: ago(3 * DAY) }, title: 'Merge' }],
    }));
    // A fresh question goes above an approval waiting 3 of 4 days; the review gate stays below the tier.
    expect(mixed.items.map((item) => item.key)).toEqual(['question:m:mgr:fresh', 'approval:mgr:a1']);
    expect(mixed.olderAfterDays).toBe(4);
  });

  it('only a PR that ended after the wait or question began settles it (review finding 2)', () => {
    const list = buildAttentionList(sources({
      questions: [
        question('m:mgr:before', { askedAt: ago(10), questions: [{ header: 'M', question: 'Follow up on [[pr:app/4]]?', options: [] }] }),
        question('m:mgr:after', { askedAt: ago(10), questions: [{ header: 'M', question: 'Merge [[pr:app/5]]?', options: [] }] }),
        question('m:mgr:when', { askedAt: ago(10), questions: [{ header: 'M', question: 'Merge [[pr:app/6]]?', options: [] }] }),
      ],
      projects: [{ id: 'app', runs: [
        // Continued after its PR merged: the new wait is live.
        run('continued', { status: 'waiting', waitingSince: ago(5), markerRefs: { pr: 3 } }),
        run('waiting', { status: 'waiting', waitingSince: ago(5), markerRefs: { pr: 2 } }),
      ] }],
      prEnded: (_projectId, r) => (r.id === 'continued' ? { number: 3, state: 'merged', endedAt: ago(60) } : { number: 2, state: 'merged', endedAt: ago(1) }),
      prState: (_projectId, number) => (number === 4 ? { state: 'merged', endedAt: ago(30) } : number === 5 ? { state: 'merged', endedAt: ago(2) } : { state: 'merged' }),
    }));
    const settled = Object.fromEntries(list.items.map((item) => [item.runId ?? item.key, item.settled?.detail]));
    expect(settled).toEqual({
      continued: undefined,
      waiting: 'PR #2 merged',
      'question:m:mgr:before': undefined,
      'question:m:mgr:after': 'PR #5 it mentions was merged',
      // No end time known: nothing is settled on a guess.
      'question:m:mgr:when': undefined,
    });
  });

  it('settles on the task’s current PR, never a superseded one (review finding 1)', () => {
    const at = (minutes: number) => ago(minutes);
    expect(currentTaskPr({ prRefs: [{ number: 10, origin: 'created', at: at(60) }, { number: 12, origin: 'created', at: at(5) }, { number: 99, origin: 'derived', at: at(1) }] })).toBe(12);
    expect(currentTaskPr({ pullRequestUrl: 'https://github.com/o/r/pull/7', markerRefs: { pr: 3 } })).toBe(7);
    expect(currentTaskPr({ markerRefs: { pr: 3 } })).toBe(3);
    expect(currentTaskPr({ prRefs: [{ number: 99, origin: 'derived', at: at(1) }] })).toBeUndefined();
    // Legacy refs share the run's createdAt: a tie goes to created over marker (review 2, finding 4).
    const same = at(30);
    expect(currentTaskPr({ prRefs: [{ number: 7, origin: 'created', at: same }, { number: 8, origin: 'marker', at: same }] })).toBe(7);
    expect(currentTaskPr({ prRefs: [{ number: 8, origin: 'marker', at: same }, { number: 7, origin: 'created', at: same }] })).toBe(7);
  });

  it('keeps a task dismissed after its dismissed question’s card closes (review finding 3)', () => {
    const waiting = run('wait', { status: 'waiting', waitingSince: ago(30) });
    const asked = question('r:app:wait:req', { askedAt: ago(20), source: { kind: 'task', projectId: 'app', runId: 'wait', title: 'Task wait', status: 'waiting' } });
    const dismissal = { key: 'question:r:app:wait:req', mode: 'dismiss' as const, at: ago(10), projectId: 'app', runId: 'wait' };
    // While asking: one row, the question, dismissed.
    expect(buildAttentionList(sources({ questions: [asked], projects: [{ id: 'app', runs: [waiting] }], overrides: [dismissal] })).items).toEqual([]);
    // The card closed: the run's wait comes back under its task key, and stays dismissed.
    const closed = buildAttentionList(sources({ projects: [{ id: 'app', runs: [waiting] }], overrides: [dismissal] }));
    expect(closed.items).toEqual([]);
    expect(closed.overrides[0]).toMatchObject({ projectId: 'app', runId: 'wait' });
    // A new wait after the dismissal is news again.
    const again = buildAttentionList(sources({ projects: [{ id: 'app', runs: [run('wait', { status: 'waiting', waitingSince: ago(1) })] }], overrides: [dismissal] }));
    expect(again.items.map((item) => item.kind)).toEqual(['task']);
  });

  it('counts a manager’s live approvals and questions for the notch (review finding 6)', () => {
    const list = buildAttentionList(sources({
      questions: [question('m:mgr:q1'), question('m:mgr:q2', { stale: { why: 'manager-acted', detail: 'x', since: ago(1) } }), question('m:mgr:q3')],
      approvals: [{ managerId: 'mgr', message: action('a1'), title: 'Merge' }],
      overrides: [{ key: 'question:m:mgr:q3', mode: 'dismiss', at: ago(1) }],
    }));
    expect(managerNeedsYou(list.items, 'mgr')).toEqual({ approvals: 1, questions: 1 });
    // Muted: still listed for the notch, out of the badges only (review 2, finding 3).
    const muted = buildAttentionList(sources({ questions: [question('m:mgr:q1')], managers: [{ id: 'mgr', name: 'Shop manager', important: 0, notify: false }] }));
    expect(managerNeedsYou(muted.items, 'mgr')).toEqual({ approvals: 0, questions: 1 });
    expect(muted.counts.total).toBe(0);
  });

  it('hides a dismissed item until its key changes, and "keep" overrides the detection', () => {
    const base = {
      questions: [question('m:mgr:q1', { stale: { why: 'manager-acted' as const, detail: 'the manager acted', since: ago(1) } })],
      projects: [{ id: 'app', runs: [run('wait', { status: 'waiting', waitingSince: ago(3) })] }],
    };
    const first = buildAttentionList(sources(base));
    const taskKey = first.items.find((item) => item.kind === 'task')!.key;
    const dismissed = buildAttentionList(sources({ ...base, overrides: [{ key: taskKey, mode: 'dismiss', at: ago(1) }, { key: 'question:m:mgr:q1', mode: 'keep', at: ago(1) }] }));
    expect(dismissed.items.map((item) => [item.kind, item.settled, item.counted])).toEqual([['question', undefined, true]]);
    expect(dismissed.counts.total).toBe(1);
    expect(dismissed.revision).not.toBe(first.revision);
    // A new wait is a new key: it shows again.
    const raised = buildAttentionList(sources({ ...base, projects: [{ id: 'app', runs: [run('wait', { status: 'waiting', waitingSince: ago(1) })] }], overrides: [{ key: taskKey, mode: 'dismiss', at: ago(1) }] }));
    expect(raised.items.some((item) => item.kind === 'task')).toBe(true);
  });

  it('brings a snoozed item back once its snooze ends', () => {
    const base = { projects: [{ id: 'app', runs: [run('wait', { status: 'waiting', waitingSince: ago(3) })] }] };
    const key = buildAttentionList(sources(base)).items[0]!.key;
    const snoozed = (until: number) => buildAttentionList(sources({ ...base, overrides: [{ key, mode: 'dismiss', at: ago(1), until: new Date(NOW + until * 60_000).toISOString() }] }));
    expect(snoozed(30).items).toEqual([]);
    expect(snoozed(-1).items.map((item) => item.key)).toEqual([key]);
    expect(snoozed(-1).overrides).toEqual([]);
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
