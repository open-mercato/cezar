import { describe, expect, it, vi } from 'vitest';
import { TrackerPoller } from './tracker-poller.ts';
import type { TrackerAutomationDefinition } from './types.ts';
import type { TrackerDriver } from '../server/tracker/types.ts';
import type { TrackerEventCandidate } from './event-source.ts';
const association = { kind: 'jira' as const, source: { id: 's', webUrl: 'https://example.atlassian.net' }, externalId: '1', externalName: 'Demo' };
const definition: TrackerAutomationDefinition = {
  id: 'todo', revision: 1, name: 'Watch To Do', enabled: true, kind: 'tracker',
  intervalSeconds: 1800, filters: { lookbackDays: 7, maxRecords: 25 },
  trackerTrigger: { events: ['issue.status_changed'], targetStatusIds: ['todo'], association },
  task: { prompt: 'Work on {{tracker.key}}' }, createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z',
};
const event: TrackerEventCandidate = { eventId: 'history:1', event: 'issue.status_changed', timestamp: '2026-09-19T01:00:00.000Z', tieBreaker: '1', provider: 'jira', association, issueId: '123', key: 'ABC-1', title: 'Issue', url: 'https://example.atlassian.net/browse/ABC-1', status: 'Done', labels: [], change: { fromId: 'progress', toId: 'todo' } };
function driver(candidates: TrackerEventCandidate[]): TrackerDriver {
  return { association, listIssues: vi.fn(), searchItems: vi.fn(), getItem: vi.fn(), pollEvents: vi.fn(async () => ({ candidates, checkpoint: 'opaque', complete: false })) };
}
describe('TrackerPoller event facade', () => {
  it('matches the historical target ID even if current issue status differs', async () => {
    const source = driver([event, { ...event, eventId: 'history:2', change: { fromId: 'todo', toId: 'progress' } }]);
    const result = await new TrackerPoller().poll(source, definition, { baselineAt: definition.createdAt });
    expect(result.candidates).toEqual([event]);
    expect(result).toMatchObject({ checkpoint: 'opaque', truncated: true });
    expect(source.listIssues).not.toHaveBeenCalled();
  });
  it('preserves distinct transitions to the same status and provider IDs', async () => {
    const events = [event, { ...event, eventId: 'history:3' }];
    const result = await new TrackerPoller().poll(driver(events), definition, { baselineAt: definition.createdAt, checkpoint: 'resume' });
    expect(result.candidates).toEqual(events);
  });
  it('refuses legacy status snapshots', async () => {
    await expect(new TrackerPoller().poll(driver([]), { ...definition, trackerTrigger: undefined } as never, { baselineAt: definition.createdAt })).rejects.toThrow('Choose an event');
  });
});

it('opened-only polling skips unavailable history through the actual scanner', async () => {
  const { createEventScanner } = await import('../server/tracker/event-scan.ts');
  const scanner = createEventScanner(association, async () => ({ issues: [{ id: '1', key: 'ABC-1', title: 'Issue', url: event.url, createdAt: event.timestamp, status: 'Done', labels: [] }] }), async () => { throw new Error('history unavailable'); });
  const source = { ...driver([]), pollEvents: scanner.poll };
  const result = await new TrackerPoller().poll(source, { ...definition, trackerTrigger: { association, events: ['issue.opened'] } }, { baselineAt: definition.createdAt });
  expect(result.candidates.map(item => item.event)).toEqual(['issue.opened']);
});

it.each(['jira', 'linear'] as const)('requires all exact label names before delivering %s candidates, preserving progress', async provider => {
  const candidates = [[], ['bug'], ['Bug', 'urgent'], ['bug', 'urgent']].map((labels, i) => ({ ...event, provider, event: 'issue.opened' as const, eventId: String(i), labels }));
  const configured = { ...definition, trackerTrigger: { association, events: ['issue.opened' as const], requiredLabels: ['bug', 'urgent'] } };
  const result = await new TrackerPoller().poll(driver(candidates), configured, { baselineAt: definition.createdAt });
  expect(result.candidates).toEqual([candidates[3]]);
  expect(result.checkpoint).toBe('opaque');
  const empty = await new TrackerPoller().poll(driver(candidates), { ...configured, trackerTrigger: { ...configured.trackerTrigger, requiredLabels: [] } }, { baselineAt: definition.createdAt });
  expect(empty.candidates).toEqual(candidates);
});

it('validates bounded required label names and preserves the optional no-filter contract', async () => {
  const { trackerTriggerSchema } = await import('@open-mercato/cezar-contract');
  const base = { association, events: ['issue.opened'] };
  expect(trackerTriggerSchema.parse(base).requiredLabels).toBeUndefined();
  expect(trackerTriggerSchema.parse({ ...base, requiredLabels: [' bug '] }).requiredLabels).toEqual(['bug']);
  for (const requiredLabels of [[' '], ['a'.repeat(201)], Array(101).fill('bug')]) {
    expect(trackerTriggerSchema.safeParse({ ...base, requiredLabels }).success).toBe(false);
  }
});
