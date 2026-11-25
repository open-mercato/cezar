import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubReviewCommentsDataSchema } from '@open-mercato/cezar-contract';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import {
  __clearRepoHandleCacheForTests,
  __clearReviewCommentsCacheForTests,
  fetchGithubReviewComments,
} from './github.ts';
import {
  applyResolved,
  mockGithubReviewComments,
  normalizeReviewComments,
  parseResolvedThreads,
  REVIEW_COMMENT_CAP,
} from './github-review-comments.ts';

const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  user: { login: 'ada', avatar_url: 'https://a/1' },
  created_at: '2026-11-01T00:00:00Z',
  body: 'looks off',
  html_url: 'https://github.com/o/r/pull/7#discussion_r1',
  path: 'src/a.ts',
  side: 'RIGHT',
  line: 10,
  original_line: 10,
  start_line: null,
  original_start_line: null,
  position: 4,
  subject_type: 'line',
  diff_hunk: '@@ -1,1 +1,1 @@\n-a\n+b',
  ...over,
});

describe('normalizeReviewComments', () => {
  it('maps RIGHT to new and LEFT to old', () => {
    const { comments } = normalizeReviewComments([row(), row({ id: 2, side: 'LEFT', line: 3 })]);
    expect(comments.map((c) => [c.id, c.side, c.line])).toEqual([[1, 'new', 10], [2, 'old', 3]]);
    expect(comments[0]).toMatchObject({ author: 'ada', avatarUrl: 'https://a/1', outdated: false, subjectType: 'line' });
  });

  it('keeps an outdated comment with its original line', () => {
    const { comments } = normalizeReviewComments([row({ line: null, original_line: 8, position: null })]);
    expect(comments[0]).toMatchObject({ outdated: true, originalLine: 8 });
    expect(comments[0]!.line).toBeUndefined();
  });

  it('carries the start of a multi-line comment', () => {
    const { comments } = normalizeReviewComments([
      row({ start_line: 7, start_side: 'RIGHT', original_start_line: 7, line: 10 }),
    ]);
    expect(comments[0]).toMatchObject({ startLine: 7, startSide: 'new', originalStartLine: 7, line: 10 });
  });

  it('drops a start line equal to the line', () => {
    const { comments } = normalizeReviewComments([row({ start_line: 10, original_start_line: 10 })]);
    expect(comments[0]!.startLine).toBeUndefined();
    expect(comments[0]!.originalStartLine).toBeUndefined();
  });

  it('threads replies by inReplyTo and gives them the root anchor', () => {
    const { comments } = normalizeReviewComments([
      row({ id: 1, line: 10, start_line: 8 }),
      row({ id: 2, in_reply_to_id: 1, created_at: '2026-11-02T00:00:00Z', line: 99, side: 'LEFT', start_line: null }),
    ]);
    const reply = comments.find((c) => c.id === 2)!;
    expect(reply).toMatchObject({ inReplyTo: 1, side: 'new', line: 10, startLine: 8, path: 'src/a.ts' });
  });

  it('treats a file-level comment as current unless GitHub lost its position', () => {
    const { comments } = normalizeReviewComments([
      row({ id: 1, subject_type: 'file', line: null, original_line: null, position: 1 }),
      row({ id: 2, subject_type: 'file', line: null, original_line: null, position: null }),
    ]);
    expect(comments.map((c) => [c.subjectType, c.outdated, c.line])).toEqual([
      ['file', false, undefined],
      ['file', true, undefined],
    ]);
  });

  it('sorts oldest first, caps entries and flags the cut', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ id: i + 1, created_at: `2026-11-0${5 - i}T00:00:00Z` }),
    );
    const { comments, truncated } = normalizeReviewComments(rows, 3);
    expect(comments.map((c) => c.id)).toEqual([5, 4, 3]);
    expect(truncated).toBe(true);
    expect(REVIEW_COMMENT_CAP).toBeGreaterThan(100);
  });

  it('caps the body and keeps only the tail of the hunk', () => {
    const hunk = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n');
    const { comments } = normalizeReviewComments([row({ body: 'x'.repeat(9000), diff_hunk: hunk })]);
    expect(comments[0]!.body).toHaveLength(8000);
    expect(comments[0]!.diffHunk!.split('\n')).toHaveLength(12);
    expect(comments[0]!.diffHunk!.endsWith('+line 39')).toBe(true);
  });

  it('drops a malformed row without losing the rest', () => {
    const { comments } = normalizeReviewComments([{ id: 'nope' }, row({ id: 3 })]);
    expect(comments.map((c) => c.id)).toEqual([3]);
  });

  it('produces contract-valid output', () => {
    const { comments } = normalizeReviewComments([row(), row({ id: 2, line: null })]);
    expect(githubReviewCommentsDataSchema.safeParse({ available: true, comments }).success).toBe(true);
  });
});

describe('resolved threads', () => {
  const graphql = (nodes: unknown[]) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

  it('marks roots only', () => {
    const { comments } = normalizeReviewComments([row({ id: 1 }), row({ id: 2, in_reply_to_id: 1 }), row({ id: 3 })]);
    applyResolved(
      comments,
      parseResolvedThreads(graphql([
        { isResolved: true, comments: { nodes: [{ databaseId: 1 }] } },
        { isResolved: false, comments: { nodes: [{ databaseId: 2 }] } },
      ])),
    );
    expect(comments.map((c) => [c.id, c.resolved])).toEqual([[1, true], [2, undefined], [3, undefined]]);
  });

  it('throws on a malformed answer', () => {
    expect(() => parseResolvedThreads('{"data":{}}')).toThrow();
  });
});

describe('mockGithubReviewComments', () => {
  it('is contract-valid and covers each case', () => {
    const data = mockGithubReviewComments();
    expect(githubReviewCommentsDataSchema.safeParse(data).success).toBe(true);
    const c = data.comments;
    expect(c.some((x) => x.outdated && x.line === undefined && x.originalLine)).toBe(true);
    expect(c.some((x) => x.inReplyTo !== undefined)).toBe(true);
    expect(c.some((x) => x.startLine !== undefined)).toBe(true);
    expect(c.some((x) => x.side === 'old')).toBe(true);
    expect(c.some((x) => x.path !== 'notes.md')).toBe(true);
  });
});

type Answer = (argv: string[]) => string | Error;
function answerGh(answer: Answer) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cmd = args[0] as string;
    const argv = args[1] as string[];
    const cb = args[args.length - 1] as (e: unknown, r?: unknown) => void;
    if (cmd !== 'gh') return cb(new Error('not a git repo'));
    const out = answer(argv);
    if (out instanceof Error) cb(out);
    else cb(null, { stdout: out, stderr: '' });
  });
}
const restCalls = () =>
  execFileMock.mock.calls.filter((c) => c[0] === 'gh' && (c[1] as string[]).some((a) => a.includes('/comments?')));

describe('fetchGithubReviewComments', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
    __clearReviewCommentsCacheForTests();
    __clearRepoHandleCacheForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  const page = (from: number, count: number) =>
    JSON.stringify(Array.from({ length: count }, (_, i) => row({ id: from + i, created_at: `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z` })));

  it('walks every page until a short one and fills resolved state', async () => {
    answerGh((argv) => {
      const n = /&page=(\d+)$/.exec(argv.find((a) => a.includes('/comments?')) ?? '')?.[1];
      if (n === '1') return page(1, 100);
      if (n === '2') return page(101, 3);
      if (argv[0] === 'repo') return 'o/r\n';
      if (argv[1] === 'graphql')
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
          { isResolved: true, comments: { nodes: [{ databaseId: 1 }] } },
        ] } } } } });
      return '[]';
    });
    const data = await fetchGithubReviewComments('/repo/rc-a', 7);
    expect(data.available).toBe(true);
    expect(data.comments).toHaveLength(103);
    expect(data.truncated).toBeUndefined();
    expect(data.comments.find((c) => c.id === 1)!.resolved).toBe(true);
    expect(restCalls()).toHaveLength(2);
    expect(restCalls()[0]![1]).toContain('repos/{owner}/{repo}/pulls/7/comments?per_page=100&page=1');
  });

  it('flags truncated when the page cap stops the walk', async () => {
    answerGh((argv) => (argv.some((a) => a.includes('/comments?')) ? page(1, 100) : new Error('no graphql')));
    const data = await fetchGithubReviewComments('/repo/rc-cap', 7);
    expect(data.available).toBe(true);
    expect(data.truncated).toBe(true);
    expect(restCalls()).toHaveLength(10);
  });

  it('leaves resolved absent when GraphQL fails', async () => {
    answerGh((argv) => {
      if (argv.some((a) => a.includes('/comments?'))) return JSON.stringify([row()]);
      if (argv[0] === 'repo') return 'o/r\n';
      return new Error('HTTP 502');
    });
    const data = await fetchGithubReviewComments('/repo/rc-gql', 7);
    expect(data.available).toBe(true);
    expect(data.comments[0]!.resolved).toBeUndefined();
  });

  it('serves the cache inside the TTL and re-fetches on refresh', async () => {
    answerGh((argv) => (argv.some((a) => a.includes('/comments?')) ? JSON.stringify([row({ in_reply_to_id: 99 })]) : '[]'));
    const first = await fetchGithubReviewComments('/repo/rc-cache', 7);
    const calls = execFileMock.mock.calls.length;
    expect(await fetchGithubReviewComments('/repo/rc-cache', 7)).toBe(first);
    expect(execFileMock.mock.calls.length).toBe(calls);
    await fetchGithubReviewComments('/repo/rc-cache', 7, true);
    expect(execFileMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it('degrades when gh is missing', async () => {
    answerGh(() => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    const data = await fetchGithubReviewComments('/repo/rc-enoent', 7);
    expect(data).toEqual({ available: false, reason: expect.stringContaining('gh CLI not found'), comments: [] });
  });

  it('degrades on a 404', async () => {
    answerGh(() => new Error('gh: Not Found (HTTP 404)'));
    const data = await fetchGithubReviewComments('/repo/rc-404', 7);
    expect(data.available).toBe(false);
    expect(data.reason).toMatch(/not found/i);
  });

  it('returns the fixture under CEZ_DRY_RUN without spawning gh', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const data = await fetchGithubReviewComments('/repo/rc-dry', 7);
    expect(data.comments.length).toBeGreaterThan(0);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
