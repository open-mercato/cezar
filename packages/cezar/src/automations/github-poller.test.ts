import { describe, expect, it, vi } from 'vitest';
import {
  buildSearchQuery,
  GithubPoller,
  lastPageOfLinkHeader,
  matchesFilters,
  onePerPullRequest,
  POLL_RECORD_CEILING,
  reconstructLabelEvents,
  reconstructReviewEvents,
} from './github-poller.ts';
import type { GithubCandidate } from './github-poller.ts';
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

  it('talks to an enterprise host and accepts its repository_url shapes', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [
      { ...item, node_id: 'ghes', repository_url: 'https://ghe.corp.example/api/v3/repos/acme/demo' },
      { ...item, node_id: 'cloud', repository_url: 'https://api.company.ghe.com/repos/Acme/Demo' },
      { ...item, node_id: 'foreign', repository_url: 'https://ghe.corp.example/api/v3/repos/evil/demo' },
    ] }));
    const result = await new GithubPoller({ run, host: 'ghe.corp.example' }).poll('acme', 'demo', definition);
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['api', '--hostname', 'ghe.corp.example', '/search/issues']));
    expect(result.candidates.map((c) => c.nodeId).sort()).toEqual(['cloud', 'ghes']);
  });

  it('accepts the Enterprise Cloud repository_url on a *.ghe.com host', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [
      { ...item, node_id: 'cloud', repository_url: 'https://api.acme.ghe.com/repos/acme/demo' },
      { ...item, node_id: 'foreign', repository_url: 'https://api.acme.ghe.com/repos/acme/other' },
    ] }));
    const result = await new GithubPoller({ run, host: 'acme.ghe.com' }).poll('acme', 'demo', definition);
    expect(result.candidates.map((c) => c.nodeId)).toEqual(['cloud']);
  });

  it('adds no --hostname for github.com', async () => {
    const run = vi.fn(async (_executable: string, _args: readonly string[]) => JSON.stringify({ items: [] }));
    await new GithubPoller({ run, host: 'github.com' }).poll('acme', 'demo', definition);
    expect(run.mock.calls[0]?.[1]).not.toContain('--hostname');
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

  it('splits closed pull requests into disjoint merged and closed events with one closed: search', async () => {
    const pr = (number: number, closedAt: string | null, mergedAt?: string | null) => ({
      ...item, node_id: `PR_${number}`, number, html_url: `https://github.com/acme/demo/pull/${number}`,
      updated_at: '2026-07-26T05:00:00.000Z', closed_at: closedAt,
      pull_request: { url: 'https://api.github.com/x', merged_at: mergedAt ?? null },
    });
    const run = vi.fn(async () => JSON.stringify({ items: [
      pr(1, '2026-07-26T03:00:00.000Z', '2026-07-26T03:00:00.000Z'),
      pr(2, '2026-07-26T02:00:00.000Z'),
      pr(3, null),
      pr(4, '2026-07-20T00:00:00.000Z'),
    ] }));
    const poll = (events: GithubAutomationDefinition['events']) => new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition, events,
    }, { since: '2026-07-25T23:58:00.000Z' });

    const both = await poll(['pull_request.closed', 'pull_request.merged']);
    expect(both.candidates.map((c) => [c.event, c.number, c.timestamp])).toEqual([
      ['pull_request.closed', 2, '2026-07-26T02:00:00.000Z'],
      ['pull_request.merged', 1, '2026-07-26T03:00:00.000Z'],
    ]);
    expect(both.candidates[1]?.eventId).toBe('acme/demo:PR_1:pull_request.merged:2026-07-26T03:00:00.000Z');
    expect(both.cursor?.timestamp).toBe('2026-07-26T03:00:00.000Z');
    const [, args] = run.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(expect.arrayContaining([
      'sort=updated',
      expect.stringMatching(/is:pr closed:>=2026-07-25T23:58:00.000Z/),
    ]));

    const mergedOnly = await poll(['pull_request.merged']);
    expect(mergedOnly.candidates.map((c) => c.number)).toEqual([1]);
    // The unselected closed PR still moves the cursor, as every observation does.
    expect(mergedOnly.cursor?.timestamp).toBe('2026-07-26T03:00:00.000Z');
  });

  it('reads every page of a full closed search so the cursor never passes an unread close', async () => {
    // Search orders by `updated`; PR 1 closed first but was touched last, so it sits on page 2.
    const pr = (number: number, closedAt: string, updatedAt: string) => ({
      ...item, node_id: `PR_${number}`, number, html_url: `https://github.com/acme/demo/pull/${number}`,
      updated_at: updatedAt, closed_at: closedAt, pull_request: { merged_at: null },
    });
    const late = Array.from({ length: 100 }, (_, index) => pr(
      100 + index,
      `2026-07-26T05:${String(Math.floor(index / 2)).padStart(2, '0')}:00.000Z`,
      '2026-07-26T06:00:00.000Z',
    ));
    const early = pr(1, '2026-07-26T01:00:00.000Z', '2026-07-26T09:00:00.000Z');
    const run = vi.fn(async (_executable: string, args: readonly string[]) =>
      JSON.stringify({ items: args.includes('page=2') ? [early] : late }));
    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition, events: ['pull_request.closed'], filters: { lookbackDays: 7, maxRecords: 25 },
    }, { since: '2026-07-26T00:00:00.000Z' });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.candidates[0]?.number).toBe(1);
    expect(result.candidates).toHaveLength(25);
    expect(result.truncated).toBe(true);
    expect(result.cursor?.timestamp).toBe('2026-07-26T05:11:00.000Z');
  });

  it('keeps polling when the timeline carries entries other than labeled/unlabeled', async () => {
    // Every issue anyone has commented on has such an entry, so validating the
    // whole `/timeline` array against `timelineEventSchema` made label triggers
    // unusable: the throw escaped `poll()` and no candidate on the page was
    // evaluated — not even from issues whose own history is all labels (#914).
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.some((arg) => arg.includes('/timeline'))) {
        return JSON.stringify([
          { id: 1, event: 'labeled', created_at: '2026-07-26T02:00:00.000Z', label: { name: 'other' } },
          { id: 2, event: 'commented', created_at: '2026-07-26T02:01:00.000Z' },
          { id: 3, event: 'cross-referenced', created_at: '2026-07-26T02:02:00.000Z' },
          { id: 4, event: 'labeled', created_at: '2026-07-26T02:03:00.000Z', label: { name: 'triage' } },
        ]);
      }
      return JSON.stringify({ items: [item] });
    });

    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      events: ['issue.labeled'],
      filters: { ...definition.filters, changedLabels: ['triage'] },
    }, { since: '2026-07-26T01:00:00.000Z' });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      event: 'issue.labeled',
      number: 7,
      changedLabel: 'triage',
      timestamp: '2026-07-26T02:03:00.000Z',
    });
  });

  it('drops a labeled entry whose label is malformed instead of failing the poll', async () => {
    // The filter is `safeParse`, not a widened schema: `timelineEventSchema`
    // still defines what an entry must look like to be reconstructed from.
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.some((arg) => arg.includes('/timeline'))) {
        return JSON.stringify([
          { id: 1, event: 'labeled', created_at: '2026-07-26T02:00:00.000Z' },
          { id: 2, event: 'labeled', created_at: '2026-07-26T02:01:00.000Z', label: { name: 'triage' } },
        ]);
      }
      return JSON.stringify({ items: [item] });
    });

    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      events: ['issue.labeled'],
      filters: { ...definition.filters, changedLabels: ['triage'] },
    }, { since: '2026-07-26T01:00:00.000Z' });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ changedLabel: 'triage' });
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

  it('reconstructs a submitted review as pull_request.reviewed, carrying the reviewer', () => {
    const rows = reconstructReviewEvents('acme', 'demo', item, [
      { id: 1, event: 'reviewed', submitted_at: '2026-07-26T02:00:00.000Z', user: { login: 'carol' } },
    ]);
    expect(rows).toEqual([expect.objectContaining({ event: 'pull_request.reviewed', reviewer: 'carol' })]);
  });

  it('emits only review_requested for a first-time request', () => {
    const rows = reconstructReviewEvents('acme', 'demo', item, [
      { id: 1, event: 'review_requested', created_at: '2026-07-26T02:00:00.000Z', requested_reviewer: { login: 'carol' } },
    ]);
    expect(rows.map((row) => row.event)).toEqual(['pull_request.review_requested']);
  });

  it('also emits rereview_requested when the requested reviewer already reviewed the PR', () => {
    const rows = reconstructReviewEvents('acme', 'demo', item, [
      { id: 1, event: 'reviewed', submitted_at: '2026-07-26T01:00:00.000Z', user: { login: 'carol' } },
      { id: 2, event: 'review_requested', created_at: '2026-07-26T02:00:00.000Z', requested_reviewer: { login: 'carol' } },
    ]);
    expect(rows.map((row) => row.event)).toEqual([
      'pull_request.reviewed',
      'pull_request.review_requested',
      'pull_request.rereview_requested',
    ]);
    expect(rows[1]?.reviewer).toBe('carol');
    expect(rows[2]?.reviewer).toBe('carol');
  });

  it('launches a re-request once, as rereview_requested, when both request events are selected', async () => {
    const pullRequest = { ...item, node_id: 'PR_one', number: 8, html_url: 'https://github.com/acme/demo/pull/8', pull_request: {} };
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.some((arg) => arg.includes('/timeline'))) {
        return JSON.stringify([
          { id: 1, event: 'review_requested', created_at: '2026-07-26T01:00:00.000Z', requested_reviewer: { login: 'carol' } },
          { id: 2, event: 'reviewed', submitted_at: '2026-07-26T02:00:00.000Z', user: { login: 'carol' } },
          { id: 3, event: 'review_requested', created_at: '2026-07-26T03:00:00.000Z', requested_reviewer: { login: 'carol' } },
          { id: 4, event: 'commented', created_at: '2026-07-26T03:30:00.000Z' },
        ]);
      }
      return JSON.stringify({ items: [pullRequest] });
    });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      events: ['pull_request.review_requested', 'pull_request.rereview_requested'],
    });
    // The first request is superseded too: one launch per PR per poll, the latest request.
    expect(result.candidates.map((candidate) => [candidate.event, candidate.tieBreaker])).toEqual([
      ['pull_request.rereview_requested', '3:rereview'],
    ]);
  });

  it('collapses several reviewers requested on one PR into one launch, per event family', () => {
    const base = { repo: 'acme/demo', nodeId: 'PR', title: 'x', url: item.html_url, author: 'alice', assignees: [], labels: [] };
    const row = (event: GithubCandidate['event'], number: number, tieBreaker: string, reviewer?: string): GithubCandidate =>
      ({ ...base, eventId: `${number}:${event}:${tieBreaker}`, event, number, timestamp: `2026-07-26T0${tieBreaker}:00:00.000Z`, tieBreaker, reviewer });
    const kept = onePerPullRequest([
      row('pull_request.review_requested', 8, '1', 'a'),
      row('pull_request.review_requested', 8, '2', 'b'),
      row('pull_request.reviewed', 8, '3', 'a'),
      row('pull_request.review_requested', 9, '4', 'c'),
      row('issue.opened', 10, '5'),
      row('pull_request.rereview_requested', 8, '6', 'a'),
    ]);
    expect(kept.map((candidate) => [candidate.number, candidate.event, candidate.tieBreaker])).toEqual([
      [8, 'pull_request.reviewed', '3'],
      [9, 'pull_request.review_requested', '4'],
      [10, 'issue.opened', '5'],
      [8, 'pull_request.rereview_requested', '6'],
    ]);
  });

  it('searches only open PRs for the review events', async () => {
    const run = vi.fn(async (_executable: string, args: readonly string[]) =>
      args.some((arg) => arg.includes('/timeline')) ? '[]' : JSON.stringify({ items: [] }));
    await new GithubPoller({ run }).poll('acme', 'demo', { ...definition, events: ['pull_request.reviewed', 'issue.opened'] });
    const queries = run.mock.calls.map(([, args]) => args.find((arg) => arg.startsWith('q=')) ?? '');
    expect(queries.find((query) => query.includes('updated:'))).toContain('is:pr is:open');
    expect(queries.find((query) => query.includes('created:'))).not.toContain('is:open');
  });

  it('reads the NEWEST timeline pages, since GitHub returns the oldest first', async () => {
    const pullRequest = { ...item, node_id: 'PR_one', number: 8, html_url: 'https://github.com/acme/demo/pull/8', pull_request: {} };
    const filler = (index: number) => ({ id: index, event: 'commented', created_at: '2026-07-01T00:00:00.000Z' });
    const pages: Record<string, unknown[]> = {
      '1': Array.from({ length: 100 }, (_, index) => filler(index + 1)),
      '6': Array.from({ length: 100 }, (_, index) => filler(index + 500)),
      '7': [{ id: 900, event: 'reviewed', submitted_at: '2026-07-26T02:00:00.000Z', user: { login: 'carol' } }],
    };
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (!args.some((arg) => arg.includes('/timeline'))) return JSON.stringify({ items: [pullRequest] });
      if (args.includes('--include')) {
        return 'HTTP/2.0 200 OK\r\nlink: <https://api.github.com/repositories/1/issues/8/timeline?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/issues/8/timeline?per_page=100&page=7>; rel="last"\r\n\r\n[]';
      }
      const page = args.find((arg) => arg.startsWith('page='))?.slice('page='.length) ?? '1';
      return JSON.stringify(pages[page] ?? []);
    });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', { ...definition, events: ['pull_request.reviewed'] });
    // Page 1 is the oldest hundred and is dropped past the cap; the review on the LAST page fires.
    expect(result.candidates.map((candidate) => [candidate.event, candidate.reviewer])).toEqual([
      ['pull_request.reviewed', 'carol'],
    ]);
    const fetched = run.mock.calls
      .filter(([, args]) => args.some((arg) => arg.includes('/timeline')) && !args.includes('--include'))
      .map(([, args]) => args.find((arg) => arg.startsWith('page=')));
    expect(fetched).toEqual(['page=1', 'page=3', 'page=4', 'page=5', 'page=6', 'page=7']);
  });

  it('reads the last page out of a Link header, and falls back to one page', () => {
    expect(lastPageOfLinkHeader('HTTP/2.0 200\r\nlink: <https://api.github.com/x?per_page=100&page=2>; rel="next", <https://api.github.com/x?per_page=100&page=9>; rel="last"\r\n\r\n[]')).toBe(9);
    expect(lastPageOfLinkHeader('HTTP/2.0 200\r\ncontent-type: application/json\r\n\r\n[]')).toBe(1);
  });

  it('skips a row that claims an event kind but does not parse as one', () => {
    // GitHub answers `user: null` for some removed accounts; trusting `event` alone threw here,
    // and the scheduler reads a throw as a failure and backs the automation off for hours.
    const rows = reconstructReviewEvents('acme', 'demo', item, [
      { id: 1, event: 'reviewed', submitted_at: '2026-07-26T02:00:00.000Z', user: null },
      { id: 2, event: 'reviewed', submitted_at: '2026-07-26T03:00:00.000Z', user: { login: 'carol' } },
    ] as never);
    expect(rows.map((row) => row.reviewer)).toEqual(['carol']);
  });

  it('keeps reading a label timeline that carries event kinds it does not poll for', async () => {
    // Before the union's catch-all every one of these rows failed the whole page's parse.
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.some((arg) => arg.includes('/timeline'))) {
        return JSON.stringify([
          { id: 1, event: 'commented', created_at: '2026-07-26T01:00:00.000Z', body: 'hi' },
          { id: 2, event: 'subscribed', created_at: '2026-07-26T01:10:00.000Z' },
          { sha: 'abc', event: 'committed', author: { name: 'alice', date: '2026-07-26T01:20:00.000Z' } },
          { id: 3, event: 'labeled', created_at: '2026-07-26T02:00:00.000Z', label: { name: 'triage' } },
        ]);
      }
      return JSON.stringify({ items: [item] });
    });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      events: ['issue.labeled'],
      filters: { ...definition.filters, changedLabels: ['triage'] },
    });
    expect(result.candidates.map((candidate) => [candidate.event, candidate.changedLabel])).toEqual([
      ['issue.labeled', 'triage'],
    ]);
  });

  it('matches candidates by reviewer, case-insensitively', () => {
    const candidate = { eventId: 'e', event: 'pull_request.reviewed' as const, timestamp: item.created_at, tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'x', url: item.html_url, author: 'alice', assignees: [], labels: [], reviewer: 'Carol' };
    expect(matchesFilters(candidate, { ...definition, filters: { ...definition.filters, reviewers: ['carol'] } })).toBe(true);
    expect(matchesFilters(candidate, { ...definition, filters: { ...definition.filters, reviewers: ['dave'] } })).toBe(false);
    expect(matchesFilters(candidate, { ...definition, filters: { ...definition.filters, reviewers: ['CAROL'] } })).toBe(true);
  });
});
