import { describe, expect, it, vi } from 'vitest';
import { GithubPoller, matchesFilters, reconstructLabelEvents } from './github-poller.js';
import type { AutomationDefinition } from './types.js';

const definition: AutomationDefinition = {
  id: 'one', revision: 1, name: 'Issues', enabled: true,
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
