import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubDataSchema, githubSearchDataSchema } from '@open-mercato/cezar-contract';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));
import { __clearRepoHandleCacheForTests, fetchGithub, searchGithubItems } from './github.ts';

const issue = { number: 42, title: 'Login issue', author: { login: 'ada' }, createdAt: '2026-10-30T12:00:00Z', labels: [], url: 'https://github.com/owner/repo/issues/42', comments: { totalCount: 4 }, commentsCount: 4 };
const page = (nodes: unknown[], more = false) => ({ totalCount: 2, nodes, pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null } });
const ownership = { number: 42, assignees: { nodes: [{ login: 'grace' }], pageInfo: { hasNextPage: false } }, closedByPullRequestsReferences: { nodes: [{ number: 80, title: 'Fix login', state: 'MERGED', isDraft: false, url: 'https://github.com/owner/repo/pull/80' }], pageInfo: { hasNextPage: false } } };

function mockGh(failMetadata = false) {
  execFileMock.mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, value?: unknown) => void) => {
    if (file !== 'gh') return callback(null, { stdout: '', stderr: '' });
    let stdout = '';
    if (args[0] === 'repo') stdout = 'owner/repo';
    else if (args[0] === 'search') stdout = JSON.stringify([issue]);
    else if (args[1]?.includes('/issues/42')) stdout = JSON.stringify(issue);
    else if (args[1] === 'graphql') {
      const query = args[args.indexOf('-f') + 1] ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        if (failMetadata) return callback(new Error('Metadata denied'));
        stdout = JSON.stringify({ data: { repository: { issue42: ownership } } });
      } else stdout = JSON.stringify({ data: { repository: { issues: page([issue], !args.includes('issuesCursor=next')), pullRequests: page([]) } } });
    }
    callback(null, { stdout, stderr: '' });
  });
}

describe('ownership across GitHub discovery paths (#1620)', () => {
  beforeEach(() => { vi.stubEnv('CEZ_DRY_RUN', ''); execFileMock.mockReset(); __clearRepoHandleCacheForTests(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(['first page', 'cursor page', 'text search', 'number lookup'])('hydrates %s with the same additive metadata', async path => {
    mockGh();
    const result = path === 'first page' ? await fetchGithub('/ownership/first', true, 1)
      : path === 'cursor page' ? await fetchGithub('/ownership/cursor', true, 1, { issuesCursor: 'next', prsDone: true })
      : await searchGithubItems(`/ownership/${path}`, 'issue', path === 'number lookup' ? '#42' : 'Login');
    const items = 'issues' in result ? result.issues : result.items;
    expect(result.available).toBe(true);
    expect(items[0]).toMatchObject({ number: 42, comments: 4, assignees: ['grace'], linkedPrs: [{ number: 80, state: 'merged', isDraft: false }] });
    expect(('issues' in result ? githubDataSchema : githubSearchDataSchema).safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
    const calls = execFileMock.mock.calls.filter(call => call[0] === 'gh' && (call[1] as string[]).some(arg => arg.includes('closedByPullRequestsReferences')));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toMatchObject({ timeout: expect.any(Number) });
    expect((calls[0]?.[2] as { timeout: number }).timeout).toBeLessThanOrEqual(5_000);
  });

  it.each(['list', 'search', 'number'])('preserves usable %s rows when optional metadata fails', async path => {
    mockGh(true);
    const result = path === 'list' ? await fetchGithub('/ownership/failure-list', true, 1)
      : await searchGithubItems(`/ownership/failure-${path}`, 'issue', path === 'number' ? '42' : 'Login');
    const item = ('issues' in result ? result.issues : result.items)[0];
    expect(result.available).toBe(true);
    expect(item).toMatchObject({ number: 42, title: 'Login issue', comments: 4 });
    expect(item).not.toHaveProperty('assignees');
    expect(item).not.toHaveProperty('linkedPrs');
  });

  it('never hydrates PR search results as issue ownership', async () => {
    mockGh();
    await searchGithubItems('/ownership/pr', 'pr', 'Login');
    expect(execFileMock.mock.calls.some(call => (call[1] as string[]).some(arg => arg.includes('closedByPullRequestsReferences')))).toBe(false);
  });

  it('spends at most one total five-second budget across metadata batches', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockGh();
    const answer = execFileMock.getMockImplementation();
    execFileMock.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, value?: unknown) => void) => {
      const query = args.find(arg => arg.startsWith('query=')) ?? '';
      if (query.includes('issues(first:')) {
        return callback(null, { stdout: JSON.stringify({ data: { repository: { issues: page(Array.from({ length: 51 }, (_, index) => ({ ...issue, number: index + 1 }))), pullRequests: page([]) } } }), stderr: '' });
      }
      if (query.includes('closedByPullRequestsReferences')) now += 6_000;
      return answer?.(file, args, options, callback);
    });
    const result = await fetchGithub('/ownership/total-budget', true, 51);
    expect(result.issues).toHaveLength(51);
    expect(result.issues.find(item => item.number === 42)?.assignees).toEqual(['grace']);
    const calls = execFileMock.mock.calls.filter(call => (call[1] as string[]).some(arg => arg.includes('closedByPullRequestsReferences')));
    expect(calls).toHaveLength(1);
    expect(result.issues[50]).not.toHaveProperty('assignees');
  });
});
