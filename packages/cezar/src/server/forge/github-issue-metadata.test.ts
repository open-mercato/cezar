import { describe, expect, it, vi } from 'vitest';
import { githubItemSchema } from '@open-mercato/cezar-contract';
import { fetchIssueMetadata } from './github-issue-metadata.ts';

const connection = <T>(nodes: T[], hasNextPage = false) => ({ nodes, pageInfo: { hasNextPage } });
const metadata = (number: number) => ({
  number,
  assignees: connection([{ login: 'grace' }]),
  closedByPullRequestsReferences: connection([
    { number: 81, title: 'Fix login', url: 'https://github.com/owner/repo/pull/81', state: 'OPEN', isDraft: true },
    { number: 80, title: 'Previous implementation', url: 'https://github.com/other/repo/pull/80', state: 'MERGED', isDraft: false },
    { number: 79, title: 'Abandoned implementation', url: 'https://github.com/owner/repo/pull/79', state: 'CLOSED', isDraft: false },
  ]),
});
const response = (repository: unknown) => JSON.stringify({ data: { repository } });

describe('issue ownership metadata (#1620)', () => {
  it('uses authoritative references with closed/merged inclusion, bounded nested fields and repo variables', async () => {
    const run = vi.fn(async () => response({ issue42: metadata(42) }));
    const data = await fetchIssueMetadata(run, 'owner', 'repo', [42]);
    expect(run).toHaveBeenCalledOnce();
    const [query, variables] = run.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(variables).toEqual({ owner: 'owner', name: 'repo' });
    expect(query).toContain('assignees(first: 10)');
    expect(query).toContain('closedByPullRequestsReferences(first: 10, includeClosedPrs: true, orderByState: true)');
    expect(query).not.toMatch(/timelineItems|crossReferenced|body|comments|statusCheckRollup/);
    expect(data.get(42)).toEqual({
      assignees: ['grace'],
      linkedPrs: metadata(42).closedByPullRequestsReferences.nodes.map(pr => ({ ...pr, state: pr.state.toLowerCase() })),
    });
  });

  it('batches 51 issues in two queries, deduplicates and rejects unsafe numbers', async () => {
    const run = vi.fn(async () => response({}));
    await fetchIssueMetadata(run, 'owner', 'repo', [...Array.from({ length: 51 }, (_, i) => i + 1), 1, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]);
    expect(run).toHaveBeenCalledTimes(2);
    const queries = run.mock.calls.map(call => (call as unknown as [string])[0]);
    expect(queries[0]?.match(/: issue\(/g)).toHaveLength(50);
    expect(queries[1]?.match(/: issue\(/g)).toHaveLength(1);
    expect(queries[1]).toContain('issue51: issue(number: 51)');
    expect(queries.join('')).not.toMatch(/Infinity|number: -|number: 1\.5/);
  });

  it('caps the overall work at 1000 issues and does no work for an empty input', async () => {
    const run = vi.fn(async () => response({}));
    await fetchIssueMetadata(run, 'owner', 'repo', []);
    expect(run).not.toHaveBeenCalled();
    await fetchIssueMetadata(run, 'owner', 'repo', Array.from({ length: 1100 }, (_, i) => i + 1));
    expect(run).toHaveBeenCalledTimes(20);
  });

  it('distinguishes successful empty connections from absent/null/inaccessible metadata', async () => {
    const empty = { number: 1, assignees: connection([]), closedByPullRequestsReferences: connection([]) };
    const run = vi.fn(async () => response({ issue1: empty, issue2: null, issue3: { number: 3 }, issue4: { number: 4, assignees: null, closedByPullRequestsReferences: null }, issue5: { number: 5, assignees: connection([null]), closedByPullRequestsReferences: connection([null]) } }));
    const data = await fetchIssueMetadata(run, 'owner', 'repo', [1, 2, 3, 4, 5]);
    expect(data.get(1)).toEqual({ assignees: [], linkedPrs: [] });
    expect(data.has(2)).toBe(false);
    for (const number of [3, 4, 5]) expect(data.get(number)).toEqual({});
  });

  it('marks incomplete connections and preserves another batch after failure', async () => {
    const partial = metadata(51);
    partial.assignees.pageInfo.hasNextPage = true;
    partial.closedByPullRequestsReferences.pageInfo.hasNextPage = true;
    const run = vi.fn().mockRejectedValueOnce(new Error('scope missing')).mockResolvedValueOnce(response({ issue51: partial }));
    const data = await fetchIssueMetadata(run, 'owner', 'repo', Array.from({ length: 51 }, (_, i) => i + 1));
    expect(data.has(1)).toBe(false);
    expect(data.get(51)).toMatchObject({ assignees: ['grace'], assigneesTruncated: true, linkedPrsTruncated: true });
  });

  it.each(['not JSON', response(null), response({ issue42: { ...metadata(42), number: 43 } }), response({ issue42: { ...metadata(42), assignees: connection(Array.from({ length: 11 }, () => ({ login: 'x' }))) } })])('degrades malformed or mismatched metadata without inventing ownership: %s', async value => {
    const data = await fetchIssueMetadata(async () => value, 'owner', 'repo', [42]);
    expect(data.size).toBe(0);
  });

  it('keeps old/other-forge payloads readable and validates additive fields', () => {
    const old = { kind: 'issue', number: 1, title: 'Issue', author: 'ada', createdAt: '2026-10-30', labels: [], url: 'https://example.test/issues/1', comments: 0 };
    expect(githubItemSchema.parse(old)).toEqual(old);
    expect(githubItemSchema.parse({ ...old, assignees: [], linkedPrs: [], linkedPrsTruncated: true })).toMatchObject({ assignees: [], linkedPrs: [], linkedPrsTruncated: true });
    expect(githubItemSchema.safeParse({ ...old, linkedPrs: [{ ...metadata(1).closedByPullRequestsReferences.nodes[0], state: 'OPEN' }] }).success).toBe(false);
  });
});
