import { describe, expect, it, vi } from 'vitest';
import {
  buildSearchQuery,
  GithubPoller,
  matchesFilters,
  POLL_RECORD_CEILING,
  reconstructLabelEvents,
} from './github-poller.ts';
import type { GithubAutomationDefinition } from './types.ts';

const definition: GithubAutomationDefinition = {
  id: 'one', revision: 1, name: 'Issues', enabled: true, kind: 'github',
  events: ['issue.opened'], intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
  createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
};
const item = {
  id: 1, node_id: 'I_one', number: 7, title: 'A\u0000 title',
  html_url: 'https://github.com/acme/demo/issues/7',
  created_at: '2026-07-26T01:00:00.000Z', updated_at: '2026-07-26T01:00:00.000Z',
  user: { login: 'alice' }, assignees: [{ login: 'bob' }], labels: [{ name: 'bug' }],
  repository_url: 'https://api.github.com/repos/acme/demo',
};

describe('GithubPoller', () => {
  it('uses a fixed executable and argument array and rejects foreign repository rows', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [item, { ...item, node_id: 'foreign', repository_url: 'https://api.github.com/repos/evil/demo' }] }));
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition);
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['api', '--method', 'GET', '/search/issues']));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ repo: 'acme/demo', number: 7, title: 'A  title' });
  });

  it('drains opened and label-event searches independently in oldest-first order', async () => {
    const pullRequest = {
      ...item,
      node_id: 'PR_one',
      number: 8,
      html_url: 'https://github.com/acme/demo/pull/8',
      pull_request: {},
    };
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const query = args.find((arg) => arg.startsWith('q=')) ?? '';
      if (args.some((arg) => arg.includes('/timeline'))) {
        return JSON.stringify([
          {
            id: 1,
            event: 'labeled',
            created_at: '2026-07-20T02:00:00.000Z',
            label: { name: 'triage' },
          },
          {
            id: 9,
            event: 'labeled',
            created_at: '2026-07-26T02:00:00.000Z',
            label: { name: 'triage' },
          },
        ]);
      }
      return JSON.stringify({ items: [query.includes('is:pr') ? pullRequest : item] });
    });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      events: ['pull_request.opened', 'issue.labeled'],
      filters: { ...definition.filters, changedLabels: ['triage'] },
    }, { since: '2026-07-25T23:58:00.000Z' });

    expect(result.candidates.map((candidate) => candidate.event)).toEqual([
      'pull_request.opened',
      'issue.labeled',
    ]);
    expect(result.cursor).toEqual({
      timestamp: '2026-07-26T02:00:00.000Z',
      tieBreaker: '9',
    });
    const searchCalls = run.mock.calls.filter(([, args]) => args.includes('/search/issues'));
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0]?.[1]).toEqual(expect.arrayContaining([
      'sort=created',
      'order=asc',
      expect.stringContaining('created:>=2026-07-25T23:58:00.000Z'),
    ]));
    expect(searchCalls[1]?.[1]).toEqual(expect.arrayContaining([
      'sort=updated',
      'order=asc',
      expect.stringContaining('updated:>=2026-07-25T23:58:00.000Z'),
    ]));
  });

  it('builds activity-specific queries for opened and label-event drains', () => {
    expect(buildSearchQuery('acme', 'demo', definition, 'issues', 'created', '2026-07-25T00:00:00.000Z'))
      .toContain('created:>=2026-07-25T00:00:00.000Z');
    expect(buildSearchQuery('acme', 'demo', definition, 'issues', 'updated', '2026-07-25T00:00:00.000Z'))
      .toContain('updated:>=2026-07-25T00:00:00.000Z');
  });

  it('advances its scan cursor across locally filtered rows', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [item] }));
    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      filters: { ...definition.filters, excludeLabels: ['bug'] },
    });
    expect(result.candidates).toEqual([]);
    expect(result.cursor).toEqual({
      timestamp: item.created_at,
      tieBreaker: item.node_id,
    });
  });

  it('spends a wider one-call budget without touching the definition (#982)', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...item,
      id: index + 1,
      node_id: `I_${String(index).padStart(2, '0')}`,
      number: index + 1,
      created_at: `2026-07-26T01:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const narrow: GithubAutomationDefinition = { ...definition, filters: { ...definition.filters, maxRecords: 5 } };
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const perPage = Number(args.find((arg) => arg.startsWith('per_page='))?.slice('per_page='.length));
      return JSON.stringify({ items: items.slice(0, perPage) });
    });
    const poller = new GithubPoller({ run });

    const budgeted = await poller.poll('acme', 'demo', narrow);
    expect(run).toHaveBeenLastCalledWith('gh', expect.arrayContaining(['per_page=5']));
    expect(budgeted.candidates).toHaveLength(5);
    expect(budgeted.truncated).toBe(true);
    expect(budgeted.cursor).toEqual({ timestamp: items[4]!.created_at, tieBreaker: items[4]!.node_id });

    const widened = await poller.poll('acme', 'demo', narrow, { maxRecords: 10 });
    expect(run).toHaveBeenLastCalledWith('gh', expect.arrayContaining(['per_page=10']));
    expect(widened.candidates).toHaveLength(10);
    expect(widened.cursor).toEqual({ timestamp: items[9]!.created_at, tieBreaker: items[9]!.node_id });
    expect(narrow.filters.maxRecords).toBe(5);
  });

  it('clamps an over-wide budget to the 100-record search ceiling (#982)', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [item] }));
    await new GithubPoller({ run }).poll('acme', 'demo', definition, { maxRecords: POLL_RECORD_CEILING * 4 });
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining([`per_page=${POLL_RECORD_CEILING}`]));
  });

  it('repeats all/any/exclude/author/assignee filters locally', () => {
    const candidate = { eventId: 'e', event: 'issue.opened' as const, timestamp: item.created_at, tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'x', url: item.html_url, author: 'alice', assignees: ['bob'], labels: ['bug', 'urgent'] };
    expect(matchesFilters(candidate, { ...definition, filters: { ...definition.filters, authors: ['alice'], assignees: ['bob'], allLabels: ['bug'], anyLabels: ['urgent'], excludeLabels: ['wontfix'] } })).toBe(true);
    expect(matchesFilters(candidate, { ...definition, filters: { ...definition.filters, excludeLabels: ['bug'] } })).toBe(false);
  });

  it('reconstructs pre-event labels for removals and stable transition identities', () => {
    const rows = reconstructLabelEvents('acme', 'demo', item, [{ id: 9, event: 'unlabeled', created_at: '2026-07-26T02:00:00.000Z', label: { name: 'triage' } }]);
    expect(rows[0]).toMatchObject({ event: 'issue.unlabeled', changedLabel: 'triage', labels: expect.arrayContaining(['triage']) });
    expect(rows[0]?.eventId).toContain('issue.unlabeled:9');
  });
});
