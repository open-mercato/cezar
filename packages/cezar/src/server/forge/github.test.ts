import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so `execFileMock` exists before the (hoisted) vi.mock factory runs. `gh()` builds
// its subprocess runner from `promisify(execFile)` at module load, so the availability-probe tests
// below drive `gh repo view` entirely through this mock — no real `gh` on the box. Everything else
// in this file is pure and never touches child_process, so the default passthrough is harmless.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  execFileMock.mockImplementation((...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...args),
  );
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import {
  __clearCommentsCacheForTests,
  __clearRepoHandleCacheForTests,
  resolveRepoHandle,
  detectGithubCached,
  fetchGithubComments,
  fetchTimelinePages,
  fetchCommentCounts,
  fetchCommitChecks,
  fetchPrChecks,
  fetchRefStatuses,
  fetchGithubRefStatus,
  derivePrReferenceStatus,
  deriveIssueReferenceStatus,
  __clearRefStatusCacheForTests,
  forgetRefStatus,
  refNumberFromUrl,
  fetchGithub,
  GH_CHECKS_MAX,
  ghCheckRunSchema,
  ghTimelineEventSchema,
  mergeThread,
  mergePreflightAllowed,
  normalizeComments,
  normalizeEvents,
  normalizeReviews,
  normalizeMergeState,
  parseCountsPage,
  parseOwnerName,
  rollupToChecks,
  THREAD_ENTRY_CAP,
  TIMELINE_EVENT_CAP,
  TIMELINE_EVENT_KINDS,
} from './github.ts';
import type { ForgeComment } from './types.ts';

/** `rollupToChecks` collapses a `gh … --json statusCheckRollup` array — already zod-validated
 *  via `ghCheckRunSchema` at the call site — down to the single enum the GitHub tab renders,
 *  both on PR rows (#400) and in the detail pane's `ChecksBadge`. */

describe('ghCheckRunSchema', () => {
  it('accepts a real gh rollup entry (conclusion + status, no state)', () => {
    expect(ghCheckRunSchema.parse({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toEqual({
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      state: undefined,
    });
  });

  it('accepts a check-context style entry (state, no status/conclusion)', () => {
    expect(ghCheckRunSchema.parse({ state: 'PENDING' })).toEqual({
      state: 'PENDING',
      status: undefined,
      conclusion: undefined,
    });
  });

  it('accepts nulls for every field — gh omits fields depending on the check provider', () => {
    expect(ghCheckRunSchema.parse({ state: null, status: null, conclusion: null })).toEqual({
      state: null,
      status: null,
      conclusion: null,
    });
  });

  it('rejects a non-object entry', () => {
    expect(() => ghCheckRunSchema.parse('SUCCESS')).toThrow();
  });
});

describe('rollupToChecks', () => {
  it('returns null when the rollup is absent, null, or empty', () => {
    expect(rollupToChecks(undefined)).toBeNull();
    expect(rollupToChecks(null)).toBeNull();
    expect(rollupToChecks([])).toBeNull();
  });

  it('returns "passing" when every entry concluded SUCCESS', () => {
    expect(
      rollupToChecks([
        { conclusion: 'SUCCESS', status: 'COMPLETED', state: null },
        { conclusion: 'SUCCESS', status: 'COMPLETED', state: null },
      ]),
    ).toBe('passing');
  });

  it.each(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'])(
    'returns "failing" when any entry concluded %s, even alongside passing ones',
    (conclusion) => {
      expect(
        rollupToChecks([
          { conclusion: 'SUCCESS', status: null, state: null },
          { conclusion, status: null, state: null },
        ]),
      ).toBe('failing');
    },
  );

  it.each(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'])(
    'returns "pending" when any entry is still %s and none have failed',
    (status) => {
      expect(
        rollupToChecks([
          { conclusion: 'SUCCESS', status: null, state: null },
          { conclusion: null, status, state: null },
        ]),
      ).toBe('pending');
    },
  );

  it('failing wins over pending when both are present', () => {
    expect(
      rollupToChecks([
        { conclusion: null, status: 'IN_PROGRESS', state: null },
        { conclusion: 'FAILURE', status: null, state: null },
      ]),
    ).toBe('failing');
  });

  it('falls back through conclusion → state → status, then treats a blank as pending', () => {
    expect(rollupToChecks([{ conclusion: null, status: null, state: 'FAILURE' }])).toBe('failing');
    expect(rollupToChecks([{ conclusion: null, status: null, state: null }])).toBe('pending');
  });
});

describe('normalizeMergeState', () => {
  const ready = {
    number: 128,
    title: 'Ready PR',
    url: 'https://github.com/acme/demo/pull/128',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/ready',
    baseRefName: 'main',
    headRefOid: '0123456789abcdef0123456789abcdef01234567',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', detailsUrl: 'https://example.com/check' }],
  };

  it('offers only repository-enabled methods and marks clean authoritative state ready', () => {
    const state = normalizeMergeState(ready, {
      allow_merge_commit: false,
      allow_squash_merge: true,
      allow_rebase_merge: true,
      squash_merge_commit_title: 'PR_TITLE',
    }, { readable: true, requiredChecks: ['test'] });
    expect(state.methods).toEqual(['squash', 'rebase']);
    expect(state.defaultMethod).toBe('squash');
    expect(state.canMerge).toBe(true);
    expect(state.canOverride).toBe(false);
    expect(state.checks[0]).toMatchObject({ name: 'test', state: 'passing', required: true });
  });

  it('never presents unknown rules or a changed review decision as ready', () => {
    const unknown = normalizeMergeState({ ...ready, mergeStateStatus: 'UNKNOWN' }, {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    }, { readable: true, requiredChecks: [] });
    expect(unknown.eligibility).toBe('unknown');
    expect(unknown.canOverride).toBe(true);
    const changesRequested = normalizeMergeState({ ...ready, reviewDecision: 'CHANGES_REQUESTED' }, {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    }, { readable: true, requiredChecks: [] });
    expect(changesRequested.eligibility).toBe('blocked');
    expect(changesRequested.canOverride).toBe(true);
    expect(normalizeMergeState(ready, {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    }).eligibility).toBe('unknown');
  });

  it('never makes terminal, draft, or conflicting pull requests overridable', () => {
    const policy = {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    };
    expect(normalizeMergeState({ ...ready, state: 'CLOSED' }, policy).canOverride).toBe(false);
    expect(normalizeMergeState({ ...ready, isDraft: true }, policy).canOverride).toBe(false);
    expect(normalizeMergeState({ ...ready, mergeable: 'CONFLICTING' }, policy).canOverride).toBe(false);
  });

  it('requires explicit override intent before attempting an overridable merge', () => {
    const state = normalizeMergeState({ ...ready, reviewDecision: 'REVIEW_REQUIRED' }, {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    }, { readable: true, requiredChecks: [] });
    expect(mergePreflightAllowed(state)).toBe(false);
    expect(mergePreflightAllowed(state, true)).toBe(true);
    expect(mergePreflightAllowed({ ...state, canOverride: false }, true)).toBe(false);
  });
});

/** Comment counts (#499 Phase 1): the GraphQL seam that replaces the hard-coded `comments: 0`.
 *  The `gh`-shelling is injected as a `GraphqlRunner`, so pagination, accumulation, the page cap,
 *  and the degrade-to-empty contract are all unit-testable without a real `gh`. */

const page = (
  root: 'issues' | 'pullRequests',
  nodes: Array<{ number: number; count: number }>,
  next: string | null,
): string =>
  JSON.stringify({
    data: {
      repository: {
        [root]: {
          nodes: nodes.map((n) => ({ number: n.number, comments: { totalCount: n.count } })),
          pageInfo: { hasNextPage: next !== null, endCursor: next },
        },
      },
    },
  });

describe('parseOwnerName', () => {
  it('splits a clean owner/name handle', () => {
    expect(parseOwnerName('open-mercato/cezar')).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(parseOwnerName('  open-mercato/cezar\n')).toEqual({ owner: 'open-mercato', name: 'cezar' });
  });

  it('returns null for anything that is not exactly two parts', () => {
    expect(parseOwnerName('')).toBeNull();
    expect(parseOwnerName('cezar')).toBeNull();
    expect(parseOwnerName('a/b/c')).toBeNull();
  });
});

describe('parseCountsPage', () => {
  it('flattens nodes into a number→count map and surfaces the cursor', () => {
    expect(parseCountsPage(page('issues', [{ number: 7, count: 3 }, { number: 9, count: 0 }], 'CUR'), 'issues')).toEqual({
      counts: { 7: 3, 9: 0 },
      hasNextPage: true,
      endCursor: 'CUR',
    });
  });

  it('normalizes a missing endCursor to null', () => {
    expect(parseCountsPage(page('pullRequests', [{ number: 1, count: 2 }], null), 'pullRequests')).toEqual({
      counts: { 1: 2 },
      hasNextPage: false,
      endCursor: null,
    });
  });

  it('throws on a malformed envelope (zod boundary)', () => {
    expect(() => parseCountsPage('{"data":{"repository":{"issues":{"nodes":"nope"}}}}', 'issues')).toThrow();
  });
});

describe('fetchCommentCounts', () => {
  it('returns per-kind maps for a single page each', async () => {
    // Distinguish issues vs PRs by the query text (contains `issues(` or `pullRequests(`).
    const runGraphql = vi.fn(async (q: string) =>
      q.includes('pullRequests(')
        ? page('pullRequests', [{ number: 10, count: 4 }], null)
        : page('issues', [{ number: 1, count: 2 }], null),
    );
    const counts = await fetchCommentCounts(runGraphql, 'o', 'n');
    expect(counts).toEqual({ issues: { 1: 2 }, prs: { 10: 4 } });
  });

  it('accumulates across pages and passes the endCursor forward', async () => {
    const issuePages = [page('issues', [{ number: 1, count: 1 }], 'C1'), page('issues', [{ number: 2, count: 2 }], null)];
    let issueCall = 0;
    const runGraphql = vi.fn(async (q: string, vars: Record<string, string>) => {
      if (q.includes('pullRequests(')) return page('pullRequests', [], null);
      // Page 1 must not carry a cursor; page 2 must forward 'C1'.
      if (issueCall === 0) expect(vars.endCursor).toBeUndefined();
      else expect(vars.endCursor).toBe('C1');
      return issuePages[issueCall++]!;
    });
    const counts = await fetchCommentCounts(runGraphql, 'o', 'n');
    expect(counts.issues).toEqual({ 1: 1, 2: 2 });
  });

  it('stops at the page cap even when hasNextPage never goes false', async () => {
    const runGraphql = vi.fn(async (q: string) =>
      q.includes('pullRequests(') ? page('pullRequests', [], null) : page('issues', [{ number: 1, count: 1 }], 'MORE'),
    );
    await fetchCommentCounts(runGraphql, 'o', 'n', 3);
    // 3 issue pages + 1 PR page (PR stops immediately with no next).
    const issueCalls = runGraphql.mock.calls.filter(([q]) => !q.includes('pullRequests(')).length;
    expect(issueCalls).toBe(3);
  });

  it('degrades to empty maps when the runner throws (never fails the tab)', async () => {
    const runGraphql = vi.fn(async () => {
      throw new Error('rate limited');
    });
    expect(await fetchCommentCounts(runGraphql, 'o', 'n')).toEqual({ issues: {}, prs: {} });
  });
});

/** Comment threads (#499 Phase 2): the pure normalize/merge seam behind
 *  `GET /api/v1/github/comments/:kind/:number`. The `gh`-shelling in `fetchGithubComments` isn't
 *  unit-tested (it degrades on any failure and is covered by the route + component tests); the
 *  transforms below carry the real logic — review filtering, chronological merge, and caps. */

describe('normalizeComments', () => {
  it('maps gh issue-comment JSON into ForgeComment, capping the body and defaulting the author', () => {
    const [c] = normalizeComments([
      {
        id: 7,
        user: { login: 'ada', avatar_url: 'https://a/1.png' },
        created_at: '2026-07-01T00:00:00Z',
        body: 'hi',
        html_url: 'https://gh/1',
      },
    ]);
    expect(c).toEqual({
      id: 7,
      author: 'ada',
      avatarUrl: 'https://a/1.png',
      createdAt: '2026-07-01T00:00:00Z',
      body: 'hi',
      kind: 'comment',
      url: 'https://gh/1',
    });
  });

  it('falls back to "?" when gh omits the user and to "" for a null body', () => {
    const [c] = normalizeComments([{ id: 1, user: null, created_at: 't', body: null, html_url: 'u' }]);
    expect(c?.author).toBe('?');
    expect(c?.body).toBe('');
    expect(c?.avatarUrl).toBeUndefined();
  });

  it('slices an over-long body to 8 000 chars', () => {
    const [c] = normalizeComments([
      { id: 1, user: { login: 'x' }, created_at: 't', body: 'a'.repeat(9_000), html_url: 'u' },
    ]);
    expect(c?.body).toHaveLength(8_000);
  });
});

describe('normalizeReviews', () => {
  const review = (state: string, body: string | null) => ({
    id: 1,
    user: { login: 'rev' },
    body,
    state,
    submitted_at: '2026-07-02T00:00:00Z',
    html_url: 'https://gh/r',
  });

  it('keeps APPROVED / CHANGES_REQUESTED even with an empty body (the state is the signal)', () => {
    expect(normalizeReviews([review('APPROVED', '')])).toHaveLength(1);
    expect(normalizeReviews([review('CHANGES_REQUESTED', null)])).toHaveLength(1);
    expect(normalizeReviews([review('APPROVED', '')])[0]).toMatchObject({
      kind: 'review',
      reviewState: 'approved',
    });
  });

  it('drops empty-body COMMENTED and PENDING reviews (no signal in a flat thread)', () => {
    expect(normalizeReviews([review('COMMENTED', '  ')])).toHaveLength(0);
    expect(normalizeReviews([review('PENDING', '')])).toHaveLength(0);
  });

  it('keeps a COMMENTED review that carries a body', () => {
    const out = normalizeReviews([review('COMMENTED', 'a note')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'review', reviewState: 'commented', body: 'a note' });
  });
});

describe('mergeThread', () => {
  const at = (iso: string, over: Partial<ForgeComment> = {}): ForgeComment => ({
    id: 1,
    author: 'a',
    createdAt: iso,
    body: '',
    kind: 'comment',
    url: 'u',
    ...over,
  });

  it('merges lists and sorts oldest-first by createdAt', () => {
    const { comments, truncated } = mergeThread([
      [at('2026-07-03T00:00:00Z', { id: 3 })],
      [at('2026-07-01T00:00:00Z', { id: 1 }), at('2026-07-02T00:00:00Z', { id: 2 })],
    ]);
    expect(comments.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
  });

  it('caps at the entry limit and flags truncation', () => {
    const many = Array.from({ length: THREAD_ENTRY_CAP + 5 }, (_, i) =>
      at(`2026-07-01T00:00:${String(i).padStart(2, '0')}Z`, { id: i }),
    );
    const { comments, truncated } = mergeThread([many], THREAD_ENTRY_CAP);
    expect(comments).toHaveLength(THREAD_ENTRY_CAP);
    expect(truncated).toBe(true);
  });
});

/** Per-project cache isolation (multi-project workspace, step 2.6). Both in-process caches in
 *  this module — the 60 s list cache behind `fetchGithub` and the per-thread comments cache
 *  behind `fetchGithubComments` — used to be keyed process-globally, so within one TTL window
 *  project B was served project A's (possibly private) GitHub data. These regression tests drive
 *  `gh` entirely through `execFileMock`, answering by the subprocess `cwd` (= `repoRoot`), and
 *  assert one project's payload is NEVER served under another project's scope. */

/** Route every mocked `gh` invocation by argv + cwd. */
const ghByCwd = () =>
  execFileMock.mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    const opts = args[2] as { cwd?: string } | undefined;
    const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
    const who = opts?.cwd?.includes('proj-b') ? 'b' : 'a';
    let stdout = '';
    if (argv[0] === 'repo') stdout = `owner/${who}\n`;
    else if (argv[0] === 'issue')
      stdout = JSON.stringify([
        {
          number: 1,
          title: `${who}-issue`,
          author: { login: who },
          createdAt: '2026-07-01T00:00:00Z',
          labels: [],
          body: `${who} body`,
          url: `https://github.com/owner/${who}/issues/1`,
        },
      ]);
    else if (argv[0] === 'pr') stdout = '[]';
    else if (argv[1]?.includes('/comments'))
      stdout = JSON.stringify([
        {
          id: 1,
          user: { login: `${who}-commenter` },
          created_at: '2026-07-01T00:00:00Z',
          body: `${who} says hi`,
          html_url: `https://github.com/owner/${who}/pull/42#c1`,
        },
      ]);
    else if (argv[1]?.includes('/reviews')) stdout = '[]';
    else stdout = '{}'; // graphql counts — malformed page degrades to empty maps
    cb(null, { stdout, stderr: '' });
  });

describe('fetchGithub per-project list-cache isolation (step 2.6)', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the cache path we're testing
    execFileMock.mockReset();
    ghByCwd();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never serves project A\'s issues/PRs to project B inside the TTL window', async () => {
    const a = await fetchGithub('/repo/list-iso/proj-a');
    expect(a.repo).toBe('owner/a');
    expect(a.issues[0]?.title).toBe('a-issue');

    // Within A's 60 s TTL: B must trigger its own fetch, not read A's entry.
    const b = await fetchGithub('/repo/list-iso/proj-b');
    expect(b.repo).toBe('owner/b');
    expect(b.issues[0]?.title).toBe('b-issue');

    // Per-key TTL semantics survive the scoping: A is still served from cache…
    const calls = execFileMock.mock.calls.length;
    const a2 = await fetchGithub('/repo/list-iso/proj-a');
    expect(a2).toBe(a); // same cached object, no new gh calls
    expect(execFileMock.mock.calls.length).toBe(calls);
    // …and it is A's data, not B's (B's fetch didn't overwrite A's key).
    expect(a2.issues[0]?.title).toBe('a-issue');
  });
});

describe('fetchGithubComments per-project cache isolation (step 2.6)', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
    ghByCwd();
    __clearCommentsCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not collide two projects that both have a PR #42', async () => {
    const a = await fetchGithubComments('/repo/thread-iso/proj-a', 'pr', 42);
    expect(a.comments[0]?.author).toBe('a-commenter');

    // Old key was `pr#42` — B would have been served A's thread from cache.
    const b = await fetchGithubComments('/repo/thread-iso/proj-b', 'pr', 42);
    expect(b.comments[0]?.author).toBe('b-commenter');
    expect(b.comments[0]?.body).toBe('b says hi');

    // A's entry survives B's write and still serves from cache (no new gh calls).
    const calls = execFileMock.mock.calls.length;
    const a2 = await fetchGithubComments('/repo/thread-iso/proj-a', 'pr', 42);
    expect(a2).toBe(a);
    expect(execFileMock.mock.calls.length).toBe(calls);
  });
});

/** `detectGithubCached` backs `GET /api/v1/health`'s `forge.available`, which gates the GitHub nav
 *  item. The sidebar flicker bug was this returning `null` (→ item hidden) for one 5 s health poll
 *  every time the 60 s probe cache expired; the fix is stale-while-revalidate — keep serving the
 *  last-known answer while a background probe refreshes it, so the item never blinks out. */
describe('detectGithubCached', () => {
  const CACHE_MS = 60_000; // mirrors the constant in github.ts
  const repoRoot = '/repo/detect-swr'; // distinct root so the module-level cache is isolated

  /** Resolve `gh repo view` as if it succeeded — promisify(execFile) resolves with our value. */
  const ghOk = () =>
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(null, { stdout: '{"nameWithOwner":"o/r"}', stderr: '' });
    });

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the cache path we're testing
    vi.useFakeTimers();
    vi.setSystemTime(0);
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('serves the last-known availability instead of null once the cache goes stale', async () => {
    ghOk();

    // Cold start: nothing cached yet → null (contract-safe "unknown"), and it fires one probe.
    expect(detectGithubCached(repoRoot)).toBeNull();
    await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget probe settle
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Warm: within the 60 s window the cached result is served with no new probe.
    expect(detectGithubCached(repoRoot)).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Cache expires. The bug returned null here (item vanishes); the fix returns the stale value.
    vi.setSystemTime(CACHE_MS + 1);
    expect(detectGithubCached(repoRoot)).toEqual({ available: true });

    // …and a background revalidate was kicked off exactly once for the stale read.
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

// ---- timeline events (#525) -------------------------------------------------

describe('ghTimelineEventSchema (#525)', () => {
  it('parses an unknown event type instead of throwing, so the allowlist can drop it', () => {
    // `event` is deliberately a loose z.string(): a new GitHub event type must never fail the
    // parse of the whole page. It parses here and gets dropped downstream by TIMELINE_EVENT_KINDS.
    const row = { event: 'convert_to_draft', id: 1, created_at: '2026-01-01T00:00:00Z' };
    expect(() => ghTimelineEventSchema.parse(row)).not.toThrow();
    expect(ghTimelineEventSchema.parse(row).event).toBe('convert_to_draft');
  });

  it('strips extras — the git author email must never reach the wire type', () => {
    const parsed = ghTimelineEventSchema.parse({
      event: 'committed',
      sha: 'a'.repeat(40),
      author: { name: 'Ada', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' },
      verification: { verified: true },
    });
    expect(parsed.author).toEqual({ name: 'Ada', date: '2026-01-01T00:00:00Z' });
    expect(parsed.author).not.toHaveProperty('email');
    expect(parsed).not.toHaveProperty('verification');
  });

  it('tolerates the null identity and timestamp fields real rows carry', () => {
    // Verified against a real timeline: `committed` omits `id` entirely and returns
    // `created_at: null`; `cross-referenced` returns null for BOTH `id` and `node_id`.
    expect(() =>
      ghTimelineEventSchema.parse({ event: 'committed', created_at: null, sha: 'b'.repeat(40) }),
    ).not.toThrow();
    expect(() =>
      ghTimelineEventSchema.parse({ event: 'cross-referenced', id: null, node_id: null }),
    ).not.toThrow();
  });
});

describe('TIMELINE_EVENT_KINDS (#525)', () => {
  it('excludes `reviewed` so reviews are not rendered twice', () => {
    // Timeline `reviewed` rows do carry a body and would work — but /pulls/{n}/reviews is already
    // normalized, chipped and empty-body-filtered, so sourcing both would duplicate every review.
    expect(TIMELINE_EVENT_KINDS.has('reviewed' as never)).toBe(false);
  });

  it('excludes the noise github.com itself does not surface', () => {
    for (const noise of ['subscribed', 'mentioned', 'review_requested', 'referenced']) {
      expect(TIMELINE_EVENT_KINDS.has(noise as never)).toBe(false);
    }
  });

  it('covers exactly the 11 kinds the wire type declares', () => {
    expect([...TIMELINE_EVENT_KINDS].sort()).toEqual(
      [
        'assigned',
        'closed',
        'committed',
        'cross-referenced',
        'head_ref_force_pushed',
        'labeled',
        'merged',
        'renamed',
        'reopened',
        'unassigned',
        'unlabeled',
      ],
    );
  });
});

describe('timeline fetch bounds (#525)', () => {
  it('caps each stream at its own 200 — the normalizers cannot see each other', () => {
    // The unit half of the independence claim: each normalizer caps its own stream. This alone
    // cannot rule out a combined cap, which would live in fetchGithubComments — that is covered
    // end-to-end by 'returns a full 200 comments AND 200 events from one over-long timeline'
    // in the integration block below.
    const events = Array.from({ length: 250 }, (_, i) => ({
      event: 'labeled', id: i,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      actor: { login: 'a' }, label: { name: `l${i}` },
    }));
    const comments: ForgeComment[] = Array.from({ length: 250 }, (_, i) => ({
      id: i, author: 'a', createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      body: '', kind: 'comment', url: `u${i}`,
    }));

    expect(normalizeEvents(events).events).toHaveLength(200);
    expect(mergeThread([comments]).comments).toHaveLength(200);
  });
});

describe('normalizeEvents (#525)', () => {
  const SHA = 'a'.repeat(40);
  const commitRow = (over: Record<string, unknown> = {}) => ({
    event: 'committed',
    // Verified against a real timeline: `committed` omits `id` and returns `created_at: null`.
    created_at: null,
    sha: SHA,
    message: 'fix(forge): bound the timeline page loop',
    author: { name: 'Ada Lovelace', email: 'ada@example.com', date: '2026-01-02T03:04:05Z' },
    html_url: `https://github.com/o/r/commit/${SHA}`,
    ...over,
  });

  it('resolves a committed timestamp from author.date, never leaving it null', () => {
    // THE trap this whole function exists to avoid: `created_at` is null on commits, and mapping
    // it naively yields createdAt: null, which string-sorts to the top and reorders the thread.
    const { events } = normalizeEvents([commitRow()]);
    expect(events).toHaveLength(1);
    expect(events[0]!.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(events[0]!.createdAt).not.toBeNull();
  });

  it('normalizes a non-UTC author.date to UTC so the string sort stays correct', () => {
    // author.date arrives with a numeric offset. Left alone, '2026-01-02T09:00:00+09:00' sorts
    // AFTER '2026-01-02T03:00:00Z' by string compare, when it is actually a minute earlier.
    const { events } = normalizeEvents([
      commitRow({ author: { name: 'Ada', date: '2026-01-02T09:00:00+09:00' } }),
    ]);
    expect(events[0]!.createdAt).toBe('2026-01-02T00:00:00.000Z');
    expect(events[0]!.createdAt.endsWith('Z')).toBe(true);
  });

  it('uses the git author name for commits and the actor login for everything else', () => {
    // A `committed` row carries a git author (name/email), not a GitHub actor — no login, no
    // avatar, and the email must never reach the wire type.
    const { events } = normalizeEvents([
      commitRow(),
      {
        event: 'labeled',
        id: 7,
        created_at: '2026-01-03T00:00:00Z',
        actor: { login: 'octocat', avatar_url: 'https://avatars/1' },
        label: { name: 'bug', color: 'd73a4a' },
      },
    ]);
    expect(events[0]!.actor).toBe('Ada Lovelace');
    expect(events[0]!.avatarUrl).toBeUndefined();
    expect(JSON.stringify(events[0])).not.toContain('ada@example.com');
    expect(events[1]!.actor).toBe('octocat');
    expect(events[1]!.avatarUrl).toBe('https://avatars/1');
  });

  it('drops unknown event types rather than throwing', () => {
    const { events } = normalizeEvents([
      { event: 'subscribed', id: 1, created_at: '2026-01-01T00:00:00Z' },
      { event: 'mentioned', id: 2, created_at: '2026-01-01T00:00:00Z' },
      { event: 'review_requested', id: 3, created_at: '2026-01-01T00:00:00Z' },
      { event: 'some_future_event', id: 4, created_at: '2026-01-01T00:00:00Z' },
      { event: 'closed', id: 5, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' } },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['closed']);
  });

  it('drops `reviewed` so reviews are not rendered twice', () => {
    const { events } = normalizeEvents([
      { event: 'reviewed', id: 9, submitted_at: '2026-01-01T00:00:00Z', body: 'LGTM' },
    ]);
    expect(events).toEqual([]);
  });

  it('drops an event with no resolvable timestamp instead of sorting it arbitrarily', () => {
    const { events } = normalizeEvents([
      { event: 'closed', id: 1, created_at: null, actor: { login: 'a' } },
      commitRow({ author: { name: 'Ada', date: null } }),
      { event: 'labeled', id: 2, created_at: 'not-a-date', label: { name: 'x' } },
    ]);
    expect(events).toEqual([]);
  });

  it('maps each kind onto its own fields', () => {
    const { events } = normalizeEvents([
      { event: 'labeled', id: 1, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' }, label: { name: 'bug', color: 'd73a4a' } },
      { event: 'unlabeled', id: 2, created_at: '2026-01-01T00:00:01Z', actor: { login: 'a' }, label: { name: 'wip' } },
      { event: 'assigned', id: 3, created_at: '2026-01-01T00:00:02Z', actor: { login: 'a' }, assignee: { login: 'bob' } },
      { event: 'unassigned', id: 4, created_at: '2026-01-01T00:00:03Z', actor: { login: 'a' }, assignee: { login: 'bob' } },
      { event: 'renamed', id: 5, created_at: '2026-01-01T00:00:04Z', actor: { login: 'a' }, rename: { from: 'old', to: 'new title' } },
      { event: 'merged', id: 6, created_at: '2026-01-01T00:00:05Z', actor: { login: 'a' } },
      { event: 'closed', id: 7, created_at: '2026-01-01T00:00:06Z', actor: { login: 'a' } },
      { event: 'reopened', id: 8, created_at: '2026-01-01T00:00:07Z', actor: { login: 'a' } },
      { event: 'head_ref_force_pushed', id: 10, created_at: '2026-01-01T00:00:08Z', actor: { login: 'a' } },
      {
        event: 'cross-referenced',
        id: null,
        node_id: null,
        created_at: '2026-01-01T00:00:09Z',
        actor: { login: 'a' },
        source: { issue: { number: 520, title: 'Sibling work', html_url: 'https://github.com/o/r/pull/520', pull_request: {} } },
      },
      commitRow({ author: { name: 'Ada', date: '2026-01-01T00:00:10Z' } }),
    ]);

    expect(events.map((e) => e.kind)).toEqual([
      'labeled', 'unlabeled', 'assigned', 'unassigned', 'renamed',
      'merged', 'closed', 'reopened', 'head_ref_force_pushed', 'cross-referenced', 'committed',
    ]);
    expect(events[0]!.label).toEqual({ name: 'bug', color: 'd73a4a' });
    expect(events[1]!.label).toEqual({ name: 'wip' }); // color omitted, not null
    expect(events[2]!.subject).toBe('bob');
    expect(events[4]!.subject).toBe('new title');
    expect(events[9]!).toMatchObject({ refNumber: 520, refTitle: 'Sibling work', refIsPr: true });
    expect(events[10]!).toMatchObject({ sha: SHA, message: 'fix(forge): bound the timeline page loop' });
  });

  it('drops a malformed sha rather than embedding it in the rollup query', () => {
    // The full-40-hex shape is an invariant the batched checks query depends on: `oid` rejects
    // anything else, and one bad value in an aliased chunk costs all 50 commits their glyphs
    // rather than just the one. Enforced at the boundary instead of assumed.
    const { events } = normalizeEvents([
      commitRow({ sha: 'abc1234' }),                       // abbreviated
      commitRow({ sha: `${'a'.repeat(39)}z`, id: 2 }),      // non-hex
      commitRow({ sha: SHA, id: 3 }),                       // valid
    ]);
    expect(events).toHaveLength(3);        // the rows still render, just without a sha
    expect(events[0]!.sha).toBeUndefined();
    expect(events[1]!.sha).toBeUndefined();
    expect(events[2]!.sha).toBe(SHA);
  });

  it('caps the commit message at its first line and 120 chars', () => {
    const { events } = normalizeEvents([
      commitRow({ message: `${'x'.repeat(200)}\n\nA long body paragraph that must not appear.` }),
    ]);
    expect(events[0]!.message).toBe('x'.repeat(120));
    expect(events[0]!.message).not.toContain('body paragraph');
  });

  it('resolves ids through id → sha → node_id → index, sha ahead of node_id', () => {
    const { events } = normalizeEvents([
      { event: 'labeled', id: 42, node_id: 'LA_x', created_at: '2026-01-01T00:00:00Z', label: { name: 'a' } },
      commitRow({ node_id: 'C_kwDOopaque' }), // carries BOTH sha and node_id → sha wins
      { event: 'cross-referenced', id: null, node_id: null, created_at: '2026-01-01T00:00:02Z', source: { issue: { number: 1 } } },
    ]);
    expect(events.map((e) => e.id)).toEqual([`evt-42`, `evt-${SHA}`, 'evt-2']);
    expect(events[1]!.id).not.toContain('C_kwDOopaque');
  });

  it('keeps ids stable across a refetch that prepends an event', () => {
    // The reason a bare index is not acceptable as the general scheme: the id becomes the React
    // key, so an index over the post-sort array shifts for every row below an insertion, and each
    // 60 s refetch would remount them — collapsing any commit group the user had expanded.
    const rows = [
      { event: 'labeled', id: 42, created_at: '2026-01-02T00:00:00Z', label: { name: 'a' } },
      commitRow(),
    ];
    const before = normalizeEvents(rows).events.map((e) => e.id);
    const after = normalizeEvents([
      { event: 'closed', id: 7, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' } },
      ...rows,
    ]).events.map((e) => e.id);
    expect(after.slice(1)).toEqual(before);
    expect(new Set(after).size).toBe(after.length);
  });

  it('documents that the index fallback is NOT stable — the reason it reaches one kind only', () => {
    // The test above uses an id-keyed and a sha-keyed row, so it would pass even if the index
    // fallback were maximally unstable. This one exercises the fallback path itself, on
    // `cross-referenced` — the only kind with no identity at all — and pins the honest answer:
    // the id DOES shift when an earlier row disappears. That is precisely why the fallback is
    // confined to one kind instead of being the general scheme; as the general scheme every row
    // below an insertion would remount on each 60 s refetch.
    const xref = { event: 'cross-referenced', id: null, node_id: null, created_at: '2026-01-02T00:00:00Z', source: { issue: { number: 1 } } };
    const withLeading = normalizeEvents([
      { event: 'closed', id: 7, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' } },
      xref,
    ]).events;
    const withoutLeading = normalizeEvents([xref]).events;

    expect(withLeading[1]!.id).toBe('evt-1');
    expect(withoutLeading[0]!.id).toBe('evt-0'); // same event, different id — known and bounded
    // It is still UNIQUE within a response, which is the property React keys actually require.
    const many = normalizeEvents([xref, xref, xref]).events.map((e) => e.id);
    expect(new Set(many).size).toBe(many.length);
  });

  it('keeps the NEWEST window when the cap fires — the opposite of mergeThread', () => {
    // The timeline arrives oldest-first. slice(0, cap) would retain 200 stale day-one `labeled`
    // rows and discard the merge and the recent commits — the exact rows #525 asks for.
    const rows = Array.from({ length: 250 }, (_, i) => ({
      event: 'labeled',
      id: i,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      actor: { login: 'a' },
      label: { name: `l${i}` },
    }));
    const { events, truncated } = normalizeEvents(rows, 200);

    expect(truncated).toBe(true);
    expect(events).toHaveLength(200);
    expect(events[events.length - 1]!.id).toBe('evt-249'); // newest retained
    expect(events[0]!.id).toBe('evt-50'); // oldest 50 dropped
    expect(events.map((e) => e.createdAt)).toEqual([...events.map((e) => e.createdAt)].sort());
  });

  it('reports truncated=false at exactly the cap — the ambiguity the return shape exists for', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      event: 'closed', id: i, created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), actor: { login: 'a' },
    }));
    const { events, truncated } = normalizeEvents(rows, 200);
    expect(events).toHaveLength(200);
    expect(truncated).toBe(false);
  });
});

describe('fetchTimelinePages (#525)', () => {
  const full = (n = 100) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ event: 'closed', id: i })));

  it('stops on a short page without flagging stoppedShort — that is the timeline ending', async () => {
    const run = vi.fn(async () => full(40));
    const { rows, stoppedShort } = await fetchTimelinePages(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(40);
    expect(stoppedShort).toBe(false);
  });

  it('walks up to the page cap, then flags stoppedShort', async () => {
    const run = vi.fn(async () => full(100)); // every page full → never a natural end
    const { rows, stoppedShort } = await fetchTimelinePages(run, { maxPages: 10 });
    expect(run).toHaveBeenCalledTimes(10);
    expect(rows).toHaveLength(1000);
    expect(stoppedShort).toBe(true);
  });

  it('shares ONE budget across pages instead of granting each the full timeout', async () => {
    // The regression this guards: gh()'s timeout is per invocation, so passing the default to each
    // page would make the loop's ceiling maxPages * budget (150 s), not budget (15 s).
    let clock = 0;
    const now = () => clock;
    const handed: number[] = [];
    const run = vi.fn(async (_page: number, timeoutMs: number) => {
      handed.push(timeoutMs);
      clock += 4_000; // each page burns 4 s of the shared 15 s
      return full(100);
    });

    const { stoppedShort } = await fetchTimelinePages(run, { budgetMs: 15_000, minPageMs: 2_000, now });

    // Each page is handed strictly LESS than the previous one — a shared, draining budget.
    expect(handed).toEqual([15_000, 11_000, 7_000, 3_000]);
    // 4 pages fit; the 5th would have 15_000 - 16_000 < 0 left, so the loop stops instead.
    expect(run).toHaveBeenCalledTimes(4);
    expect(stoppedShort).toBe(true);
    expect(clock).toBeLessThanOrEqual(16_000); // NOT 10 * 15_000
  });

  it('never spawns a page that cannot finish — the min-page floor', async () => {
    // Without the floor, 300 ms left spawns gh with a 300 ms timeout, which throws and looks
    // exactly like a real endpoint failure.
    let clock = 0;
    const now = () => clock;
    const run = vi.fn(async () => {
      clock += 14_000; // leaves 1 s — under the 2 s floor
      return full(100);
    });
    const { stoppedShort } = await fetchTimelinePages(run, { budgetMs: 15_000, minPageMs: 2_000, now });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stoppedShort).toBe(true);
  });

  it('rethrows a page-1 failure so the caller can decide whether substitution helps', async () => {
    const run = vi.fn(async () => { throw new Error('HTTP 404'); });
    await expect(fetchTimelinePages(run)).rejects.toThrow('HTTP 404');
  });

  it('keeps pages already fetched when a later page fails, rather than discarding them', async () => {
    // Falling back here would trade real events for a comments-only thread — strictly worse than
    // what the loop already holds.
    const run = vi.fn(async (page: number) => {
      if (page === 5) throw new Error('HTTP 502');
      return full(100);
    });
    const { rows, stoppedShort } = await fetchTimelinePages(run);
    expect(rows).toHaveLength(400); // pages 1-4 kept
    expect(stoppedShort).toBe(true);
  });
});

describe('fetchGithubComments timeline integration (#525)', () => {
  const repoRoot = '/tmp/repo';
  const SHA = 'c'.repeat(40);

  /** Route each `gh` invocation by the api path in its args. */
  const routeGh = (handlers: {
    timeline?: (page: number) => unknown;
    comments?: () => unknown;
    reviews?: () => unknown;
  }) =>
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      const path = argv.find((a) => a.includes('repos/{owner}/{repo}')) ?? '';
      const ok = (v: unknown) => cb(null, { stdout: JSON.stringify(v), stderr: '' });
      try {
        if (path.includes('/timeline')) {
          if (!handlers.timeline) return cb(new Error('HTTP 404'), null);
          const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
          return ok(handlers.timeline(page));
        }
        if (path.includes('/comments')) {
          if (!handlers.comments) return cb(new Error('HTTP 500'), null);
          return ok(handlers.comments());
        }
        if (path.includes('/reviews')) return ok(handlers.reviews ? handlers.reviews() : []);
      } catch (err) {
        return cb(err, null);
      }
      return cb(new Error(`unexpected gh call: ${argv.join(' ')}`), null);
    });

  const comment = (id: number) => ({
    id,
    user: { login: 'octocat', avatar_url: 'https://avatars/1' },
    created_at: `2026-01-0${id}T00:00:00Z`,
    body: `comment ${id}`,
    html_url: `https://github.com/o/r/issues/1#issuecomment-${id}`,
  });
  const commented = (id: number) => ({ event: 'commented', ...comment(id) });

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
    __clearCommentsCacheForTests();
    __clearRepoHandleCacheForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('splits the timeline into unchanged comments and normalized events', async () => {
    routeGh({
      timeline: () => [
        commented(1),
        { event: 'labeled', id: 90, created_at: '2026-01-01T12:00:00Z', actor: { login: 'octocat' }, label: { name: 'bug', color: 'd73a4a' } },
        { event: 'committed', created_at: null, sha: SHA, message: 'do the thing', author: { name: 'Ada', date: '2026-01-01T13:00:00Z' } },
        commented(2),
      ],
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(true);
    expect(data.comments.map((c) => c.id)).toEqual([1, 2]);
    expect(data.comments.every((c) => c.kind === 'comment')).toBe(true);
    expect(data.events?.map((e) => e.kind)).toEqual(['labeled', 'committed']);
    expect(data.events?.[1]).toMatchObject({ sha: SHA, actor: 'Ada' });
  });

  it('returns comments[] byte-identical to the pre-#525 output for the same rows (§2)', async () => {
    // THE backward-compatibility guarantee. The timeline's `commented` rows are shape-identical to
    // the legacy endpoint's, and they go through the SAME normalizeComments — so the array a
    // consumer sees must not move by a single field.
    const raw = [comment(1), comment(2), comment(3)];
    const expected = normalizeComments(raw);

    routeGh({ timeline: () => raw.map((c) => ({ event: 'commented', ...c })) });
    const viaTimeline = await fetchGithubComments(repoRoot, 'issue', 1);

    __clearCommentsCacheForTests();
    routeGh({ timeline: undefined, comments: () => raw }); // force the legacy path
    const viaLegacy = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(viaTimeline.comments).toEqual(expected);
    expect(viaTimeline.comments).toEqual(viaLegacy.comments);
  });

  it('normalizes a REAL timeline `commented` row — the premise the §2 guarantee rests on', async () => {
    // The byte-identical test above compares normalizeComments against itself over a fixture that
    // was BUILT by spreading a comments-endpoint row into {event:'commented'}. That proves the
    // pipeline is consistent; it cannot prove the premise, which is that GitHub's timeline actually
    // returns that shape. This fixture is a timeline `commented` row with the full key set the API
    // really sends — including keys normalizeComments does not read.
    //
    // It matters because normalizeComments sits OUTSIDE the inner try/catch: if the shape differed
    // (a missing html_url, say), the zod parse would throw past the timeline handler into the outer
    // one and return {available:false, comments:[]} — an empty thread, the exact regression the
    // inner-catch scoping exists to prevent.
    const realTimelineCommentedRow = {
      event: 'commented',
      actor: { login: 'pkarw', id: 18116827, avatar_url: 'https://avatars.githubusercontent.com/u/18116827?v=4', type: 'User' },
      id: 5024963753,
      node_id: 'IC_kwDOShuET88AAAABK4LcqQ',
      url: 'https://api.github.com/repos/open-mercato/cezar/issues/comments/5024963753',
      html_url: 'https://github.com/open-mercato/cezar/issues/525#issuecomment-5024963753',
      issue_url: 'https://api.github.com/repos/open-mercato/cezar/issues/525',
      created_at: '2026-07-20T17:07:49Z',
      updated_at: '2026-07-20T17:07:49Z',
      author_association: 'MEMBER',
      user: { login: 'pkarw', id: 18116827, avatar_url: 'https://avatars.githubusercontent.com/u/18116827?v=4', type: 'User' },
      body: '## 📸 Evidence\n\nThe GitHub tab detail thread as it renders today.',
      reactions: { url: 'https://api.github.com/…/reactions', total_count: 0 },
      performed_via_github_app: null,
    };

    // Parses without throwing, and every field the wire type promises is populated.
    const [normalized] = normalizeComments([realTimelineCommentedRow]);
    expect(normalized).toEqual({
      id: 5024963753,
      author: 'pkarw',
      avatarUrl: 'https://avatars.githubusercontent.com/u/18116827?v=4',
      createdAt: '2026-07-20T17:07:49Z',
      body: '## 📸 Evidence\n\nThe GitHub tab detail thread as it renders today.',
      kind: 'comment',
      url: 'https://github.com/open-mercato/cezar/issues/525#issuecomment-5024963753',
    });
    // The timeline-only extras must not leak onto the wire type.
    expect(normalized).not.toHaveProperty('event');
    expect(normalized).not.toHaveProperty('reactions');
    expect(normalized).not.toHaveProperty('author_association');
  });

  it('falls back to the comments endpoint on a timeline 404, still populating comments[]', async () => {
    // The outer catch's /404|not found/i branch would otherwise turn this into an empty thread —
    // which is exactly why the timeline's catch is scoped INSIDE it.
    routeGh({ timeline: undefined, comments: () => [comment(1), comment(2)] });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(true);
    expect(data.comments).toHaveLength(2);
    expect(data.events).toBeUndefined();
    expect(data.reason).toBeUndefined();
  });

  it('does not attempt the fallback when gh is missing (ENOENT)', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(new Error('spawn gh ENOENT'), null);
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(false);
    expect(data.reason).toMatch(/gh CLI not found/);
    expect(execFileMock).toHaveBeenCalledTimes(1); // no second spawn
  });

  it('tops up comments[] when the fetch stopped short on a comment-poor prefix', async () => {
    // A page-capped, event-heavy timeline: the 10-page budget holds only 3 comments, but the
    // thread really has 250. Without the top-up, comments[] silently returns 3.
    const legacy = Array.from({ length: 250 }, (_, i) => comment(i + 1));
    const labels = (page: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        event: 'labeled', id: page * 100 + i, created_at: '2026-01-01T00:00:00Z',
        actor: { login: 'a' }, label: { name: `l${page}-${i}` },
      }));
    routeGh({
      // Every page is full, so the walk runs to the page cap → stoppedShort. Only page 1 carries
      // comments, so the prefix holds 3 of the thread's real 250.
      timeline: (page) => (page === 1 ? [...labels(1).slice(0, 97), commented(1), commented(2), commented(3)] : labels(page)),
      comments: () => legacy,
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.comments).toHaveLength(THREAD_ENTRY_CAP); // repaired, not 3
    expect(data.truncated).toBe(true);
    expect(data.events?.length).toBeGreaterThan(0); // events survived the top-up
  });

  it('swallows a throwing top-up and keeps the timeline commented rows', async () => {
    // The one stated exception to the §2 guarantee — comments[] may be short here. It must NOT
    // fall through to the fallback (the same call) or the outer catch (which empties the thread).
    const labels = (page: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        event: 'labeled', id: page * 100 + i, created_at: '2026-01-01T00:00:00Z',
        actor: { login: 'a' }, label: { name: `l${page}-${i}` },
      }));
    routeGh({
      timeline: (page) => (page === 1 ? [...labels(1).slice(0, 99), commented(1)] : labels(page)),
      comments: undefined, // top-up throws
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.available).toBe(true); // NOT the empty-thread path
    expect(data.comments.map((c) => c.id)).toEqual([1]);
    expect(data.truncated).toBe(true);
  });

  it('returns a full 200 comments AND 200 events from one over-long timeline', async () => {
    // THE test a combined cap would fail. One fetch carrying 250 comments and 250 events must
    // yield 200 of each — a shared 200-slot budget could only ever produce 200 TOTAL, which is
    // the §2 break the spec's own review caught in its first draft.
    const rows = [
      ...Array.from({ length: 250 }, (_, i) => commented(i + 1)),
      ...Array.from({ length: 250 }, (_, i) => ({
        event: 'labeled', id: 10_000 + i,
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        actor: { login: 'a' }, label: { name: `l${i}` },
      })),
    ];
    routeGh({ timeline: (page) => (page === 1 ? rows.slice(0, 100) : rows.slice((page - 1) * 100, page * 100)) });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.comments).toHaveLength(THREAD_ENTRY_CAP);
    expect(data.events).toHaveLength(TIMELINE_EVENT_CAP);
    expect(data.comments.length + (data.events?.length ?? 0)).toBe(400); // NOT 200
    expect(data.truncated).toBe(true);
  });

  it('sets truncated when only the event stream was capped', async () => {
    routeGh({
      timeline: () => Array.from({ length: 250 }, (_, i) => ({
        event: 'labeled', id: i,
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        actor: { login: 'a' }, label: { name: `l${i}` },
      })),
    });

    const data = await fetchGithubComments(repoRoot, 'issue', 1);

    expect(data.events).toHaveLength(TIMELINE_EVENT_CAP);
    expect(data.truncated).toBe(true);
    expect(data.comments).toEqual([]); // comments untouched by event volume
  });

  it('attaches per-commit checks to committed events', async () => {
    const commitSha = 'd'.repeat(40);
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      const ok = (v: unknown) => cb(null, { stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
      if (argv[0] === 'repo') return ok('o/r');
      if (argv[1] === 'graphql') return ok({ data: { repository: { c0: { statusCheckRollup: { state: 'SUCCESS' } } } } });
      const path = argv.find((a) => a.includes('repos/{owner}/{repo}')) ?? '';
      if (path.includes('/timeline')) {
        return ok([{ event: 'committed', created_at: null, sha: commitSha, message: 'ship it', author: { name: 'Ada', date: '2026-01-01T00:00:00Z' } }]);
      }
      if (path.includes('/reviews')) return ok([]);
      return cb(new Error('unexpected'), null);
    });

    const data = await fetchGithubComments(repoRoot, 'pr', 1);

    expect(data.events?.[0]).toMatchObject({ kind: 'committed', sha: commitSha, checks: 'passing' });
  });

  it('leaves checks ABSENT (not null) when the rollup query fails', async () => {
    // absent = "we never found out"; null = "this commit has no CI". Both render no glyph, but the
    // values stay distinct so a diagnosis can tell them apart.
    const commitSha = 'e'.repeat(40);
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      const ok = (v: unknown) => cb(null, { stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
      if (argv[0] === 'repo') return ok('o/r');
      if (argv[1] === 'graphql') return cb(new Error('HTTP 502'), null); // rollup fails
      const path = argv.find((a) => a.includes('repos/{owner}/{repo}')) ?? '';
      if (path.includes('/timeline')) {
        return ok([{ event: 'committed', created_at: null, sha: commitSha, author: { name: 'Ada', date: '2026-01-01T00:00:00Z' } }]);
      }
      if (path.includes('/reviews')) return ok([]);
      return cb(new Error('unexpected'), null);
    });

    const data = await fetchGithubComments(repoRoot, 'pr', 1);

    expect(data.available).toBe(true);
    expect(data.events?.[0]).toMatchObject({ kind: 'committed', sha: commitSha });
    expect(data.events?.[0] && 'checks' in data.events[0]).toBe(false);
  });

  it('skips the checks query entirely when the timeline has no commits', async () => {
    routeGh({
      timeline: () => [{ event: 'labeled', id: 1, created_at: '2026-01-01T00:00:00Z', actor: { login: 'a' }, label: { name: 'bug' } }],
    });
    await fetchGithubComments(repoRoot, 'issue', 1);
    const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('graphql'))).toBe(false);
    expect(calls.some((c) => c.includes('repo view'))).toBe(false);
  });

  it('still fetches PR reviews alongside the timeline', async () => {
    routeGh({
      timeline: () => [commented(1)],
      reviews: () => [{
        id: 500, user: { login: 'rev' }, body: 'LGTM', state: 'APPROVED',
        submitted_at: '2026-01-05T00:00:00Z', html_url: 'https://github.com/o/r/pull/1#pullrequestreview-500',
      }],
    });

    const data = await fetchGithubComments(repoRoot, 'pr', 1);

    expect(data.comments.map((c) => c.kind)).toEqual(['comment', 'review']);
  });
});

describe('mergeThread is unaffected by events (#525)', () => {
  // mergeThread is deliberately left UNCHANGED by #525: it still caps comments+reviews at 200 and
  // still head-slices. Events are returned as their own array and interleaved client-side — there
  // is no server-side merge. These tests pin that separation so a later refactor cannot quietly
  // introduce a combined cap, which is the §2 defect the spec's review caught in its first draft.
  const comment = (id: number, at: string): ForgeComment => ({
    id, author: 'a', createdAt: at, body: '', kind: 'comment', url: `u${id}`,
  });

  it('takes only ForgeComment lists — events have no way in', () => {
    const comments = Array.from({ length: 250 }, (_, i) =>
      comment(i, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()),
    );
    const { comments: out, truncated } = mergeThread([comments]);
    expect(out).toHaveLength(THREAD_ENTRY_CAP);
    expect(truncated).toBe(true);
    // Still the OLDEST 200 — the pre-existing head-slice, deliberately not switched to slice(-cap)
    // like normalizeEvents. It is pre-existing behavior on a §2-frozen surface.
    expect(out[0]!.id).toBe(0);
    expect(out[out.length - 1]!.id).toBe(199);
  });

  it('produces the same output regardless of how many events the same fetch carried', () => {
    const comments = [comment(1, '2026-01-01T00:00:00Z'), comment(2, '2026-01-02T00:00:00Z')];
    const before = mergeThread([comments]);
    // Normalizing 250 events alongside must not touch the comment stream in any way.
    normalizeEvents(
      Array.from({ length: 250 }, (_, i) => ({
        event: 'labeled', id: i,
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
        actor: { login: 'a' }, label: { name: `l${i}` },
      })),
    );
    expect(mergeThread([comments])).toEqual(before);
    expect(before.truncated).toBe(false);
  });
});

describe('resolveRepoHandle (#525 Phase 2)', () => {
  const repoRoot = '/tmp/repo';

  beforeEach(() => {
    execFileMock.mockReset();
    __clearRepoHandleCacheForTests();
  });

  const ghReturns = (slug: string) =>
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(null, { stdout: slug, stderr: '' });
    });

  it('parses the handle and serves the second call from the memo', async () => {
    ghReturns('open-mercato/cezar');
    expect(await resolveRepoHandle(repoRoot)).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(await resolveRepoHandle(repoRoot)).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(execFileMock).toHaveBeenCalledTimes(1); // no second subprocess
  });

  it('memoizes a malformed slug as a permanent negative and does not retry it', async () => {
    ghReturns('not-a-clean-handle/with/too/many/parts');
    expect(await resolveRepoHandle(repoRoot)).toBeNull();
    expect(await resolveRepoHandle(repoRoot)).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1); // retrying cannot help
  });

  it('does NOT cache a thrown gh failure — one blip must not disable glyphs until restart', async () => {
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(new Error('network is unreachable'), null);
    });
    expect(await resolveRepoHandle(repoRoot)).toBeNull();

    ghReturns('open-mercato/cezar'); // the blip passes
    expect(await resolveRepoHandle(repoRoot)).toEqual({ owner: 'open-mercato', name: 'cezar' });
    expect(execFileMock).toHaveBeenCalledTimes(2); // it DID retry
  });

  it('keys the memo per repoRoot', async () => {
    ghReturns('o/one');
    expect(await resolveRepoHandle('/tmp/a')).toEqual({ owner: 'o', name: 'one' });
    ghReturns('o/two');
    expect(await resolveRepoHandle('/tmp/b')).toEqual({ owner: 'o', name: 'two' });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchCommitChecks (#525 Phase 2)', () => {
  const sha = (n: number) => String(n).padStart(40, '0');
  const reply = (states: Array<string | null | 'missing'>) =>
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          states.map((state, i) => [
            `c${i}`,
            state === 'missing' ? null : { statusCheckRollup: state === null ? null : { state } },
          ]),
        ),
      },
    });

  it('maps each alias back to its SHA', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'FAILURE', 'PENDING']));
    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1), sha(2), sha(3)]);
    expect(checks).toEqual({ [sha(1)]: 'passing', [sha(2)]: 'failing', [sha(3)]: 'pending' });
  });

  it('leaves an unknown SHA absent rather than null — the alias resolved null', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'missing']));
    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1), sha(2)]);
    expect(checks[sha(1)]).toBe('passing');
    expect(sha(2) in checks).toBe(false);
  });

  it('distinguishes "no CI configured" (null) from "not looked up" (absent)', async () => {
    const runGraphql = vi.fn(async () => reply([null]));
    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1)]);
    expect(sha(1) in checks).toBe(true);
    expect(checks[sha(1)]).toBeNull();
  });

  it('chunks at 50 SHAs, and a failed chunk costs only its own glyphs', async () => {
    const runGraphql = vi.fn(async (q: string) => {
      // Chunk 2 fails; chunk 1 must survive it.
      if (q.includes(sha(60))) throw new Error('HTTP 502');
      return reply(Array.from({ length: 50 }, () => 'SUCCESS'));
    });
    const shas = Array.from({ length: 70 }, (_, i) => sha(i + 1));

    const checks = await fetchCommitChecks(runGraphql, 'o', 'n', shas);

    expect(runGraphql).toHaveBeenCalledTimes(2); // 70 → 50 + 20
    expect(Object.keys(checks)).toHaveLength(50);
    expect(checks[sha(1)]).toBe('passing');
    expect(sha(60) in checks).toBe(false);
  });

  it('degrades to an empty map when every chunk fails, never throwing', async () => {
    const runGraphql = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchCommitChecks(runGraphql, 'o', 'n', [sha(1)])).resolves.toEqual({});
  });

  it('spawns nothing for an empty SHA list', async () => {
    const runGraphql = vi.fn();
    expect(await fetchCommitChecks(runGraphql, 'o', 'n', [])).toEqual({});
    expect(runGraphql).not.toHaveBeenCalled();
  });

  it('embeds full 40-char SHAs — oid rejects abbreviated ones', async () => {
    let sent = '';
    const runGraphql = vi.fn(async (q: string) => { sent = q; return reply(['SUCCESS']); });
    await fetchCommitChecks(runGraphql, 'o', 'n', [sha(1)]);
    expect(sent).toContain(`object(oid: "${sha(1)}")`);
    expect(sha(1)).toHaveLength(40);
  });
});

/** `fetchPrChecks` (#664) hydrates the PR row's checks glyph lazily, keyed by PR number — the list
 *  call no longer pays for `statusCheckRollup`. It mirrors `fetchCommitChecks`: aliased so N PRs
 *  cost one subprocess, each alias resolves independently, and any failure degrades to absent
 *  glyphs rather than failing the tab. */
describe('fetchPrChecks (#664)', () => {
  // One aliased `pullRequest` node per PR: `'missing'` → the alias resolved null (unknown PR),
  // `null` → the PR exists but has no CI configured, a state → that rolled-up glyph.
  const reply = (states: Array<string | null | 'missing'>) =>
    JSON.stringify({
      data: {
        repository: Object.fromEntries(
          states.map((state, i) => [
            `p${i}`,
            state === 'missing'
              ? null
              : { commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] } },
          ]),
        ),
      },
    });

  it('maps each alias back to its PR number', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'FAILURE', 'PENDING']));
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [7, 12, 20]);
    expect(checks).toEqual({ 7: 'passing', 12: 'failing', 20: 'pending' });
  });

  it('leaves an unknown PR absent rather than null — the alias resolved null', async () => {
    const runGraphql = vi.fn(async () => reply(['SUCCESS', 'missing']));
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [7, 8]);
    expect(checks[7]).toBe('passing');
    expect(8 in checks).toBe(false);
  });

  it('distinguishes "no CI configured" (null) from "not looked up" (absent)', async () => {
    const runGraphql = vi.fn(async () => reply([null]));
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [7]);
    expect(7 in checks).toBe(true);
    expect(checks[7]).toBeNull();
  });

  it('chunks at the given size, and a failed chunk costs only its own glyphs', async () => {
    const runGraphql = vi.fn(async (q: string) => {
      if (q.includes('pullRequest(number: 3)')) throw new Error('HTTP 502');
      return reply(['SUCCESS', 'SUCCESS']);
    });
    const checks = await fetchPrChecks(runGraphql, 'o', 'n', [1, 2, 3, 4], 2);
    expect(runGraphql).toHaveBeenCalledTimes(2); // [1,2] then [3,4]
    expect(checks[1]).toBe('passing');
    expect(checks[2]).toBe('passing');
    expect(3 in checks).toBe(false); // its chunk threw
    expect(4 in checks).toBe(false);
  });

  it('degrades to an empty map when every chunk fails, never throwing', async () => {
    const runGraphql = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchPrChecks(runGraphql, 'o', 'n', [7])).resolves.toEqual({});
  });

  it('spawns nothing for an empty PR list', async () => {
    const runGraphql = vi.fn();
    expect(await fetchPrChecks(runGraphql, 'o', 'n', [])).toEqual({});
    expect(runGraphql).not.toHaveBeenCalled();
  });

  it('caps a single query at GH_CHECKS_MAX aliases', () => {
    // The route caps the request at GH_CHECKS_MAX; the default chunk size matches so one query
    // never exceeds it. A defensive guard so raising one constant without the other is caught.
    expect(GH_CHECKS_MAX).toBe(100);
  });
});

/** The list tier stopped fetching `statusCheckRollup` (#664): it was the dominant cost on repos
 *  with many open PRs. This drives `gh` through `execFileMock` and asserts the PR list call omits
 *  the rollup field and that PR rows come back with `checks: null` (hydrated lazily elsewhere). */
describe('fetchGithub omits statusCheckRollup from the list call (#664)', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the gh path we are asserting on
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not request the rollup field and leaves list PR checks null', async () => {
    let prJsonArg = '';
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      let stdout = '{}';
      if (argv[0] === 'repo') stdout = 'owner/n\n';
      else if (argv[0] === 'issue') stdout = '[]';
      else if (argv[0] === 'pr') {
        prJsonArg = argv[argv.indexOf('--json') + 1] ?? '';
        stdout = JSON.stringify([
          {
            number: 7,
            title: 'a pr',
            author: { login: 'x' },
            createdAt: '2026-07-01T00:00:00Z',
            labels: [],
            body: 'b',
            url: 'https://github.com/owner/n/pull/7',
            isDraft: false,
            additions: 1,
            deletions: 2,
          },
        ]);
      }
      cb(null, { stdout, stderr: '' });
    });

    const data = await fetchGithub('/repo/no-rollup-664');
    expect(prJsonArg).not.toContain('statusCheckRollup');
    expect(prJsonArg).toContain('isDraft');
    expect(data.prs[0]?.checks).toBeNull();
  });
});

/**
 * Reference status — the batched read behind a task's PR/issue chip.
 *
 * Two things are worth pinning independently: the PRECEDENCE that collapses four independent PR
 * signals into one word (a merged PR is merged whatever CI says; a human's "changes requested"
 * outranks a red build), and the batching, which mirrors `fetchPrChecks` — one aliased query, an
 * unknown number left absent rather than invented, and any failure degrading to nothing rather
 * than to a wrong glyph.
 */
describe('derivePrReferenceStatus', () => {
  const pr = (over: Partial<Parameters<typeof derivePrReferenceStatus>[0]> = {}) =>
    derivePrReferenceStatus({ state: 'OPEN', isDraft: false, reviewDecision: null, checks: null, ...over });

  it('lets a terminal state win over everything else', () => {
    // A merged PR whose last build went red is still merged — and a draft that was closed is
    // closed, not a draft. Anything else would paint history as a to-do.
    expect(pr({ state: 'MERGED', checks: 'failing', isDraft: true })).toBe('merged');
    expect(pr({ state: 'CLOSED', checks: 'passing', reviewDecision: 'APPROVED' })).toBe('closed');
    expect(pr({ state: 'merged' })).toBe('merged'); // case-insensitive, as GraphQL enums vary
  });

  it('puts draft above every open-PR signal', () => {
    expect(pr({ isDraft: true, checks: 'passing', reviewDecision: 'APPROVED' })).toBe('draft');
  });

  it('puts running checks above a requested change — a run in flight is the newest fact', () => {
    // `reviewDecision` stays CHANGES_REQUESTED until the reviewer comes back, so a PR whose
    // author has already pushed the fix would otherwise claim to be blocked on them for as long
    // as the re-review takes. CI running means something was just pushed.
    expect(pr({ checks: 'pending', reviewDecision: 'CHANGES_REQUESTED' })).toBe('checks-pending');
    expect(pr({ checks: 'pending', reviewDecision: 'REVIEW_REQUIRED' })).toBe('checks-pending');
  });

  it('keeps a CURRENT requested change above a red build', () => {
    // Nothing has been pushed since the review and no re-review asked for, so the reviewer is
    // still describing what is there — and CI goes red and green again on its own, where a person
    // does not. This is the one case that still points at the author.
    expect(pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing' })).toBe('changes-requested');
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'failing',
        changesRequestedAt: '2026-08-11T12:00:00Z',
        headCommittedAt: '2026-08-11T09:00:00Z',
      }),
    ).toBe('changes-requested');
  });

  it('hands the ball back to the reviewer once a re-review is REQUESTED', () => {
    // Observed live: `reviewDecision` stays CHANGES_REQUESTED after the author clicks re-request,
    // and `latestReviews` comes back empty — `reviewRequests` is the only thing that says the ball
    // has moved. Without this the chip points at the author for the whole length of a re-review.
    expect(
      pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'passing', reviewRequested: true }),
    ).toBe('review-required');
    // …even with nothing pushed since, as long as the request itself POSTDATES the review.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        changesRequestedAt: '2026-08-11T12:00:00Z',
        headCommittedAt: '2026-08-11T09:00:00Z',
        reviewRequestedAt: '2026-08-11T12:30:00Z',
      }),
    ).toBe('review-required');
  });

  it('does NOT read a reviewer asked BEFORE the review as an answer to it', () => {
    // The reported case: three reviewers requested at once, one of them requested changes the
    // next day, the other two never looked — so `reviewRequests.totalCount` stays 1 with nothing
    // whatsoever having happened since. Counting that as the author re-requesting painted "Waiting
    // for review" over a live rejection, which is the opposite of whose move it is.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        reviewRequestedAt: '2026-08-18T10:28:43Z',
        changesRequestedAt: '2026-08-19T11:00:27Z',
        headCommittedAt: '2026-08-18T10:23:40Z',
      }),
    ).toBe('changes-requested');
    // A stale request does not stop a PUSH from handing the ball back, though — that rule is
    // untouched, and it is the one the reporter called fine.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        reviewRequestedAt: '2026-08-18T10:28:43Z',
        changesRequestedAt: '2026-08-19T11:00:27Z',
        headCommittedAt: '2026-08-19T14:00:00Z',
      }),
    ).toBe('review-required');
    // An undated request against a dated review is the unusable-pair case: conservative, so the
    // chip keeps pointing at the author rather than dismissing a review on a guess.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        reviewRequested: true,
        changesRequestedAt: '2026-08-19T11:00:27Z',
      }),
    ).toBe('changes-requested');
  });

  it('hands it back on a PUSH too, for an author who re-requested nothing', () => {
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T12:00:00Z',
      }),
    ).toBe('review-required');
    // One parent is an ordinary commit, stated or not — the count only ever rules a merge OUT.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T12:00:00Z',
        headParentCount: 1,
      }),
    ).toBe('review-required');
  });

  it('does NOT let "Update branch" clear a rejection — a merge answers nothing', () => {
    // GitHub's Update-branch button writes `Merge branch 'main' into <branch>` dated NOW, newer
    // than any review while addressing none of it. Shape confirmed on a real PR,
    // whose head commit reports two parents. Counting it as a push would let the one click people
    // make reflexively on a stale PR wipe a live rejection off the chip.
    const updated = {
      reviewDecision: 'CHANGES_REQUESTED' as const,
      changesRequestedAt: '2026-08-11T09:00:00Z',
      headCommittedAt: '2026-08-11T12:00:00Z',
      headParentCount: 2,
    };
    expect(pr({ ...updated, checks: 'passing' })).toBe('changes-requested');
    // An octopus merge is no more of an answer than a two-parent one.
    expect(pr({ ...updated, checks: 'passing', headParentCount: 3 })).toBe('changes-requested');
    // …but a re-request still hands the ball back, merge or no merge: that signal is the author
    // SAYING they are done, where the merge only looks like it.
    expect(
      pr({ ...updated, checks: 'passing', reviewRequested: true, reviewRequestedAt: '2026-08-11T12:30:00Z' }),
    ).toBe('review-required');
  });

  it('does NOT let a merge landing on top ERASE an answer the author already gave', () => {
    // The other half of the merge rule, and the one that bites in practice: a merge is transparent,
    // not disqualifying. Sequence — reviewer requests changes at 09:00; author pushes a real fix at
    // 12:00 (chip correctly goes blue); the base moves on and the PR conflicts; the author presses
    // this cockpit's own "Resolve conflicts" (or GitHub's "Update branch") at 15:00. Reading only
    // the head would see a 2-parent commit, discard the 12:00 fix and flip the chip back to red,
    // blaming an author who answered two steps ago. The merge's FIRST parent still carries 12:00.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T15:00:00Z',
        headParentCount: 2,
        headFirstParentCommittedAt: '2026-08-11T12:00:00Z',
      }),
    ).toBe('review-required');
    // The plain "Update branch" case is unchanged: nothing was pushed after the review, so the
    // first parent is the pre-review commit and the rejection still stands.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T15:00:00Z',
        headParentCount: 2,
        headFirstParentCommittedAt: '2026-08-11T06:00:00Z',
      }),
    ).toBe('changes-requested');
    // A merge with no first-parent date is the unusable-pair case: conservative, review stands.
    expect(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        checks: 'passing',
        changesRequestedAt: '2026-08-11T09:00:00Z',
        headCommittedAt: '2026-08-11T15:00:00Z',
        headParentCount: 2,
      }),
    ).toBe('changes-requested');
  });

  it('still puts a red build above a waiting reviewer — they cannot approve it anyway', () => {
    const answered = { changesRequestedAt: '2026-08-11T09:00:00Z', headCommittedAt: '2026-08-11T12:00:00Z' };
    expect(pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing', ...answered })).toBe('checks-failing');
    expect(pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing', reviewRequested: true })).toBe(
      'checks-failing',
    );
  });

  it('counts an explicitly requested reviewer even with no review policy at all', () => {
    // `reviewDecision` is null on a repo that requires no reviews — but somebody was still asked,
    // and calling that "ready to merge" would paint over the ask.
    expect(pr({ reviewDecision: null, checks: 'passing', reviewRequested: true })).toBe('review-required');
  });

  it('lets an APPROVAL outrank a reviewer still listed as requested', () => {
    // Real shape, observed live: approved, mergeable, green — and one reviewer left
    // on the request list after someone else approved. That is a courtesy ask, not an unmet gate,
    // and reading it as "waiting for review" would stick for as long as anyone stays listed, which
    // is indefinitely. A repo needing two approvals reports REVIEW_REQUIRED until it has both, so
    // APPROVED never arrives early.
    expect(
      pr({
        reviewDecision: 'APPROVED',
        checks: 'passing',
        reviewRequested: true,
        // A superseded changes-requested review from the same reviewer, days before the approval.
        changesRequestedAt: '2026-08-03T14:54:03Z',
        headCommittedAt: '2026-08-12T07:54:05Z',
      }),
    ).toBe('ready');
  });

  it('still puts a red build above an approval', () => {
    // Approved does not mean mergeable — the build is the author's move either way.
    expect(pr({ reviewDecision: 'APPROVED', checks: 'failing', reviewRequested: true })).toBe('checks-failing');
    expect(pr({ reviewDecision: 'APPROVED', checks: 'pending' })).toBe('checks-pending');
  });

  it('treats an unusable pair of dates as a CURRENT review', () => {
    // Conservative on purpose: a missing or unparseable date, with nothing re-requested, must not
    // silently hand the ball to a reviewer who was never asked.
    const dated = (over: Record<string, unknown>) =>
      pr({ reviewDecision: 'CHANGES_REQUESTED', checks: 'failing', ...over });
    expect(dated({ headCommittedAt: '2026-08-11T12:00:00Z' })).toBe('changes-requested');
    expect(dated({ changesRequestedAt: '2026-08-11T09:00:00Z' })).toBe('changes-requested');
    expect(dated({ headCommittedAt: 'not-a-date', changesRequestedAt: '2026-08-11T09:00:00Z' })).toBe(
      'changes-requested',
    );
  });

  it('reports the machine once no human is blocking', () => {
    expect(pr({ checks: 'failing' })).toBe('checks-failing');
    expect(pr({ checks: 'pending' })).toBe('checks-pending');
  });

  it('names a waited-on review only when nothing is failing or running', () => {
    expect(pr({ reviewDecision: 'REVIEW_REQUIRED', checks: 'passing' })).toBe('review-required');
  });

  it('calls a green PR ready — approved, or on a repo with no review policy at all', () => {
    expect(pr({ reviewDecision: 'APPROVED', checks: 'passing' })).toBe('ready');
    // `reviewDecision: null` is what a repo without required reviews answers. No approval is ever
    // coming, so withholding "ready" would leave that repo's PRs permanently unlabelled.
    expect(pr({ reviewDecision: null, checks: null })).toBe('ready');
  });
});

/**
 * The whole combination space, checked against INVARIANTS rather than a second copy of the
 * ranking.
 *
 * The precedence has been edited five times — checks-pending above a requested change, the
 * re-request handoff, `APPROVED` outranking a pending request, that handoff being narrowed to
 * requests that postdate the review, then merge commits dropping out of the push rule — and each
 * edit reordered branches that the curated examples above only sample. Restating the expected
 * answer for all 256
 * combinations would just be the implementation written twice, and would agree with a bug as
 * readily as with a fix. These are the properties that must hold whatever the ordering is; a
 * future edit that violates one is a bug by construction.
 */
describe('derivePrReferenceStatus over every combination', () => {
  const CHECKS = ['passing', 'failing', 'pending', null] as const;
  const DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null] as const;
  const BOOLS = [true, false] as const;
  const PR_STATUSES = new Set([
    'merged',
    'closed',
    'draft',
    'checks-pending',
    'checks-failing',
    'changes-requested',
    'review-required',
    'ready',
  ]);

  /** Every open, non-draft shape: 4 check states × 4 decisions × requested × pushed-since ×
   *  request-postdates-the-review × head-is-a-merge. */
  const openRows = () => {
    const rows: Parameters<typeof derivePrReferenceStatus>[0][] = [];
    for (const checks of CHECKS) {
      for (const reviewDecision of DECISIONS) {
        for (const reviewRequested of BOOLS) {
          for (const pushed of BOOLS) {
            for (const reRequested of BOOLS) {
              for (const merge of BOOLS) {
                rows.push({
                  state: 'OPEN',
                  isDraft: false,
                  reviewDecision,
                  checks,
                  reviewRequested,
                  changesRequestedAt: '2026-08-11T09:00:00Z',
                  headCommittedAt: pushed ? '2026-08-11T12:00:00Z' : '2026-08-11T06:00:00Z',
                  reviewRequestedAt: reRequested ? '2026-08-11T12:00:00Z' : '2026-08-11T06:00:00Z',
                  headParentCount: merge ? 2 : 1,
                });
              }
            }
          }
        }
      }
    }
    return rows;
  };

  const describeRow = (row: Parameters<typeof derivePrReferenceStatus>[0]) => JSON.stringify(row);

  it('covers 256 open shapes', () => {
    expect(openRows()).toHaveLength(256);
  });

  it('only ever answers with a PULL REQUEST status', () => {
    // Never an issue word: `open`, `completed` and `not-planned` belong to the other kind, and a
    // PR wearing one would be filed under the wrong bucket by the route.
    for (const row of openRows()) {
      expect(PR_STATUSES, describeRow(row)).toContain(derivePrReferenceStatus(row));
    }
  });

  it('lets a terminal state beat everything', () => {
    for (const row of openRows()) {
      expect(derivePrReferenceStatus({ ...row, state: 'MERGED' }), describeRow(row)).toBe('merged');
      expect(derivePrReferenceStatus({ ...row, state: 'CLOSED' }), describeRow(row)).toBe('closed');
      // A draft is terminal for everything below it, but not for merged/closed above.
      expect(derivePrReferenceStatus({ ...row, isDraft: true }), describeRow(row)).toBe('draft');
    }
  });

  it('reports running checks whenever they are running', () => {
    for (const row of openRows()) {
      expect(derivePrReferenceStatus({ ...row, checks: 'pending' }), describeRow(row)).toBe('checks-pending');
    }
  });

  it('never blames the author once the forge says APPROVED', () => {
    // The approved-but-still-requested class of bug: an approved PR must not read as waiting on a
    // reviewer or owing edits, however many reviewers are still listed as requested.
    for (const row of openRows()) {
      const status = derivePrReferenceStatus({ ...row, reviewDecision: 'APPROVED' });
      expect(['review-required', 'changes-requested'], describeRow(row)).not.toContain(status);
    }
  });

  it('only says changes-requested when changes ARE requested', () => {
    for (const row of openRows()) {
      if (derivePrReferenceStatus(row) === 'changes-requested') {
        expect(row.reviewDecision, describeRow(row)).toBe('CHANGES_REQUESTED');
      }
    }
  });

  it('never lets a request OLDER than the review dismiss that review', () => {
    // The stale-review-request class of bug, as an invariant: with nothing pushed since and the
    // standing request predating the review, no combination may report the ball as the reviewer's.
    for (const row of openRows()) {
      if (row.reviewDecision !== 'CHANGES_REQUESTED') continue;
      if (row.checks === 'pending' || row.checks === 'failing') continue; // those outrank it by design
      const stale =
        row.headCommittedAt === '2026-08-11T06:00:00Z' && row.reviewRequestedAt === '2026-08-11T06:00:00Z';
      if (!stale) continue;
      expect(derivePrReferenceStatus(row), describeRow(row)).toBe('changes-requested');
    }
  });

  it('never lets a MERGE at the head stand in for the author answering', () => {
    // The "Update branch" class of bug, as an invariant: with a merge commit on top and no
    // re-request, the head's date is irrelevant — a rejection stays a rejection however fresh the
    // merge is. Only `reviewRequested` may overrule it, and it does so on its own merits.
    for (const row of openRows()) {
      if (row.reviewDecision !== 'CHANGES_REQUESTED') continue;
      if (row.checks === 'pending' || row.checks === 'failing') continue; // those outrank it by design
      if (row.headParentCount !== 2) continue;
      const reRequested = row.reviewRequested === true && row.reviewRequestedAt === '2026-08-11T12:00:00Z';
      if (reRequested) continue;
      expect(derivePrReferenceStatus(row), describeRow(row)).toBe('changes-requested');
    }
  });

  it('only says checks-failing when the checks ARE failing', () => {
    for (const row of openRows()) {
      if (derivePrReferenceStatus(row) === 'checks-failing') {
        expect(row.checks, describeRow(row)).toBe('failing');
      }
    }
  });

  it('only says ready when nothing at all is outstanding', () => {
    for (const row of openRows()) {
      if (derivePrReferenceStatus(row) !== 'ready') continue;
      const why = describeRow(row);
      expect(row.checks === 'failing' || row.checks === 'pending', why).toBe(false);
      // Either the forge approved it, or nobody was ever waited on.
      const nobodyWaiting =
        row.reviewDecision === null && row.reviewRequested !== true;
      expect(row.reviewDecision === 'APPROVED' || nobodyWaiting, why).toBe(true);
    }
  });

  it('never leaves a requested reviewer unmentioned on an otherwise-quiet PR', () => {
    // No policy, nothing failing, nothing running, but somebody was explicitly asked: calling that
    // "ready to merge" would paint over the ask.
    for (const checks of ['passing', null] as const) {
      expect(
        derivePrReferenceStatus({
          state: 'OPEN',
          isDraft: false,
          reviewDecision: null,
          checks,
          reviewRequested: true,
        }),
      ).toBe('review-required');
    }
  });
});

describe('deriveIssueReferenceStatus', () => {
  it('keeps "we did it" and "we will not" apart', () => {
    expect(deriveIssueReferenceStatus({ state: 'OPEN' })).toBe('open');
    expect(deriveIssueReferenceStatus({ state: 'CLOSED', stateReason: 'COMPLETED' })).toBe('completed');
    expect(deriveIssueReferenceStatus({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toBe('not-planned');
  });

  it('reads a closed issue with no reason as completed', () => {
    // Pre-`stateReason` issues (and reopened-then-closed ones) carry nothing; "completed" is the
    // honest default — GitHub itself renders them that way.
    expect(deriveIssueReferenceStatus({ state: 'CLOSED' })).toBe('completed');
    expect(deriveIssueReferenceStatus({ state: 'CLOSED', stateReason: null })).toBe('completed');
  });
});

describe('fetchRefStatuses', () => {
  const prNode = (over: Record<string, unknown> = {}) => ({
    __typename: 'PullRequest',
    state: 'OPEN',
    // What GitHub answers for a settled open PR. Defaulted so the cases below stay about
    // STATUSES; the mergeability cases override it, and one of them omits it on purpose.
    mergeable: 'MERGEABLE',
    isDraft: false,
    reviewDecision: null,
    commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviews: { nodes: [] },
    reviewRequests: { totalCount: 0 },
    timelineItems: { nodes: [] },
    ...over,
  });
  /** A requested reviewer as both connections spell one. `Team` uses `slug` instead — see the
   *  team test below. */
  const reviewer = (login: string) => ({ __typename: 'User', login });
  const issueNode = (over: Record<string, unknown> = {}) => ({
    __typename: 'Issue',
    state: 'OPEN',
    stateReason: null,
    ...over,
  });
  const reply = (repository: Record<string, unknown>) => JSON.stringify({ data: { repository } });

  it('asks one alias per NUMBER and files each answer under what it turned out to be', async () => {
    // Issues and pull requests share one numbering space, so `issueOrPullRequest` is the question
    // with an answer — and the answer says which kind it is, rather than trusting the caller.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({ r0: prNode(), r1: prNode({ state: 'MERGED' }), r2: issueNode({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }) });
    });
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 12, 3]);
    expect(runGraphql).toHaveBeenCalledTimes(1);
    expect(sent).toContain('issueOrPullRequest');
    expect(out[7]).toEqual({ kind: 'pr', status: 'ready', mergeable: 'mergeable' });
    expect(out[12]).toEqual({ kind: 'pr', status: 'merged' });
    expect(out[3]).toEqual({ kind: 'issue', status: 'not-planned' });
  });

  it('files a number the CALLER thought was a PR under the kind it really is', async () => {
    // The screenshot bug's other half: a bare `#774` in a task can be inferred as either kind, and
    // asking `issue(number:)` about a pull request is a question GitHub answers with an error.
    const runGraphql = vi.fn(async () => reply({ r0: issueNode() }));
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [774]);
    expect(out[774]).toEqual({ kind: 'issue', status: 'open' });
  });

  it('leaves an unknown number absent rather than guessing at it', async () => {
    const runGraphql = vi.fn(async () => reply({ r0: prNode(), r1: null }));
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 8]);
    expect(out[7]?.status).toBe('ready');
    expect(8 in out).toBe(false);
  });

  it('reads a PR with no CI configured as a PR with nothing failing', async () => {
    const runGraphql = vi.fn(async () => reply({ r0: prNode({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }) }));
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('ready');
  });

  it('carries the head-commit and review timestamps into the precedence', async () => {
    // End to end for the "pushed since the review" rule: the two dates ride the same aliased
    // node, so nothing extra is spawned to learn them.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: { state: 'FAILURE' } } }] },
          reviews: { nodes: [{ submittedAt: '2026-08-11T09:00:00Z' }] },
        }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('checks-failing');
    expect(sent).toContain('committedDate');
    expect(sent).toContain('states: CHANGES_REQUESTED');
  });

  it('carries the pending review-request count into the precedence', async () => {
    // The #774 signal, end to end: `reviewDecision` still reads CHANGES_REQUESTED after the author
    // clicks re-request, so only `reviewRequests` says the ball moved. If the query stopped asking
    // for it, or the parse dropped it, the chip would silently go back to blaming the author.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({ reviewDecision: 'CHANGES_REQUESTED', reviewRequests: { totalCount: 1 } }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [774])).resolved[774]?.status).toBe('review-required');
    expect(sent).toContain('reviewRequests(first: 20) { totalCount');
  });

  it('carries the review-request DATE too, so an old request cannot dismiss a review', async () => {
    // The reported PR's exact payload. The count alone is identical to the #774 shape
    // above; only the timeline event tells the two apart, so it has to survive the query and the
    // parse — dropping either would silently restore the bug.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:23:40Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: reviewer('carol') }] },
          timelineItems: { nodes: [{ createdAt: '2026-08-18T10:28:43Z', requestedReviewer: reviewer('carol') }] },
        }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [2642])).resolved[2642]?.status).toBe('changes-requested');
    expect(sent).toContain('itemTypes: [REVIEW_REQUESTED_EVENT]');
  });

  it('dates the request that STILL STANDS, not one that was made and then withdrawn', async () => {
    // The two connections answer about different requests: `reviewRequests` is who is on the hook
    // now, a `ReviewRequestedEvent` survives the request being withdrawn. Here carol was asked
    // before the review and never looked (so she still stands), while dave was asked after it and
    // then removed. Taking the newest event blindly would date the request from dave's withdrawn
    // one, read the rejection as answered, and hide it behind "waiting for review" — the same bug
    // one step rarer. Matching by reviewer keeps the date on a request that is really there.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:00Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: reviewer('carol') }] },
          timelineItems: {
            nodes: [
              { createdAt: '2026-08-18T10:30:00Z', requestedReviewer: reviewer('carol') },
              { createdAt: '2026-08-19T14:00:00Z', requestedReviewer: reviewer('dave') }, // withdrawn
            ],
          },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('changes-requested');
  });

  it('hands the ball back when the STANDING reviewer is the one asked after the review', async () => {
    // The mirror of the test above, so the correlation cannot pass by simply never matching:
    // carol's own request postdates the review and still stands, which is a real re-request.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:00Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: reviewer('carol') }] },
          timelineItems: { nodes: [{ createdAt: '2026-08-19T14:00:00Z', requestedReviewer: reviewer('carol') }] },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('review-required');
  });

  it('matches a TEAM reviewer by slug, since a team carries no login', async () => {
    const team = { __typename: 'Team', slug: 'platform' };
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-18T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:00Z' }] },
          reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: team }] },
          timelineItems: { nodes: [{ createdAt: '2026-08-19T14:00:00Z', requestedReviewer: team }] },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('review-required');
  });

  it('carries the head commit\'s PARENT COUNT, so "Update branch" cannot clear a review', async () => {
    // A real "Update branch" head's shape: a `Merge branch 'main' into <branch>` head reporting two
    // parents. `parents(first: 0)` asks for the count and no parent — if the query or the parse
    // dropped it, the merge would read as a push and the chip would go blue on a rejected PR.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [
              {
                commit: {
                  committedDate: '2026-08-19T15:00:00Z',
                  parents: { totalCount: 2 },
                  statusCheckRollup: { state: 'SUCCESS' },
                },
              },
            ],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
        }),
      });
    });
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [2639])).resolved[2639]?.status).toBe('changes-requested');
    // `first: 1`, not `first: 0`: the first parent's date is what a merge answers WITH.
    expect(sent).toContain('parents(first: 1) { totalCount nodes { committedDate } }');
  });

  it('reads an absent parent count as an ORDINARY commit, so a real push still counts', async () => {
    // The push rule is the common path; a field GitHub declined to send must not switch it off.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          commits: {
            nodes: [{ commit: { committedDate: '2026-08-19T15:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }],
          },
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('review-required');
  });

  it('reads an absent timeline as an UNDATED request, not as a fresh one', async () => {
    // Same defensive shape as the missing `reviewRequests` below: an omitted field must not invent
    // a re-request and dismiss a review that is still about the code on screen.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({
          reviewDecision: 'CHANGES_REQUESTED',
          reviews: { nodes: [{ submittedAt: '2026-08-19T11:00:27Z' }] },
          reviewRequests: { totalCount: 1 },
          timelineItems: null,
        }),
      }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('changes-requested');
  });

  it('reads an absent reviewRequests as nobody waiting, not as somebody', async () => {
    // Defensive: a field GitHub omits must not invent a reviewer. Without the guard this would
    // throw or coerce, and every PR in the batch would lose its status.
    const runGraphql = vi.fn(async () =>
      reply({ r0: prNode({ reviewDecision: null, reviewRequests: null }) }),
    );
    expect((await fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolved[7]?.status).toBe('ready');
  });

  it('chunks past the cap, and a failed chunk costs only its own numbers', async () => {
    const runGraphql = vi.fn(async (query: string) => {
      if (query.includes('issueOrPullRequest(number: 3)')) throw new Error('HTTP 502');
      return reply({ r0: prNode(), r1: prNode() });
    });
    const { resolved: out, failed } = await fetchRefStatuses(runGraphql, 'o', 'n', [1, 2, 3, 4], 2);
    expect(runGraphql).toHaveBeenCalledTimes(2);
    expect(out[1]?.status).toBe('ready');
    expect(out[2]?.status).toBe('ready');
    expect(3 in out).toBe(false);
    expect(4 in out).toBe(false);
    // …and they are reported as UNASKED, not as absent: the difference is what keeps a network
    // blip from being cached and shown as "no such number".
    expect(failed).toEqual([3, 4]);
  });

  it('degrades to an empty map on any failure, never throwing', async () => {
    const runGraphql = vi.fn(async () => { throw new Error('offline'); });
    await expect(fetchRefStatuses(runGraphql, 'o', 'n', [7])).resolves.toEqual({
      resolved: {},
      failed: [7],
      reason: 'offline',
    });
  });

  it('spawns nothing when nothing is named', async () => {
    const runGraphql = vi.fn();
    expect(await fetchRefStatuses(runGraphql, 'o', 'n', [])).toEqual({ resolved: {}, failed: [] });
    expect(runGraphql).not.toHaveBeenCalled();
  });

  it('carries mergeability as its OWN axis, on the same query and without touching the status', async () => {
    // The reported case: green, nobody waited on, and GitHub refusing to merge it. `ready` is
    // still the honest answer to "whose move is it on the review" — the conflict is the second
    // fact, and it rides the same aliased node, so it costs no extra request.
    let sent = '';
    const runGraphql = vi.fn(async (query: string) => {
      sent = query;
      return reply({ r0: prNode({ mergeable: 'CONFLICTING' }) });
    });
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7]);

    expect(runGraphql).toHaveBeenCalledTimes(1);
    expect(sent).toContain('mergeable');
    expect(out[7]).toEqual({ kind: 'pr', status: 'ready', mergeable: 'conflicting' });
  });

  it('keeps "still computing" apart from "merges cleanly" instead of collapsing both to false', async () => {
    // `UNKNOWN` is what GitHub answers while it computes — seconds after every push — so treating
    // it as a conflict would flash an orange chip on half the pushes in the repo. Treating it as
    // CLEAN is the bug this axis was reported for a second time: it is not an answer, and it has
    // to survive as far as the cache, which asks again in seconds rather than in a minute.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({ mergeable: 'UNKNOWN' }),
        r1: prNode({ mergeable: 'MERGEABLE' }),
        r2: prNode({ mergeable: null }),
        // The field omitted entirely — `prNode` defaults it, so this strips it back off.
        r3: { ...prNode(), mergeable: undefined },
      }),
    );
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 8, 9, 10]);

    expect(out[7]?.mergeable).toBe('unknown');
    expect(out[8]?.mergeable).toBe('mergeable');
    // A field GitHub omitted, or nulled, is not a statement that the branch is clean.
    expect(out[9]?.mergeable).toBe('unknown');
    expect(out[10]?.mergeable).toBe('unknown');
  });

  it('never calls a merged or closed pull request conflicting', async () => {
    // GitHub reports UNKNOWN on a terminal PR, but a stale CONFLICTING would be worse than
    // useless: there is nothing left to resolve, and the chip would contradict `merged`.
    const runGraphql = vi.fn(async () =>
      reply({
        r0: prNode({ state: 'MERGED', mergeable: 'CONFLICTING' }),
        r1: prNode({ state: 'CLOSED', mergeable: 'CONFLICTING' }),
      }),
    );
    const { resolved: out } = await fetchRefStatuses(runGraphql, 'o', 'n', [7, 8]);

    // No `mergeable` at all — the question does not apply, which is not the same as answering it.
    expect(out[7]).toEqual({ kind: 'pr', status: 'merged' });
    expect(out[8]).toEqual({ kind: 'pr', status: 'closed' });
  });
});

/** The route-facing wrapper: one repo-handle lookup, then one batched query for the misses, and
 *  an in-payload degrade when `gh` is missing. Driven through `execFileMock` so no `gh` runs. */
describe('fetchGithubRefStatus', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the gh path under test
    execFileMock.mockReset();
    __clearRefStatusCacheForTests();
    __clearRepoHandleCacheForTests();
    // The cache is time-based, and one case needs to stand a minute later without waiting one.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function stubGh(graphqlReply: string) {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(null, { stdout: argv[0] === 'repo' ? 'owner/n\n' : graphqlReply, stderr: '' });
    });
  }

  it('serves the second identical request from cache — one visible window, one query', async () => {
    stubGh(JSON.stringify({ data: { repository: { r0: { __typename: 'PullRequest', state: 'MERGED', isDraft: false, reviewDecision: null, commits: { nodes: [] } } } } }));
    const first = await fetchGithubRefStatus('/repo/ref-status-cache', { prs: [7] });
    expect(first.available && first.prs[7]).toBe('merged');
    const calls = execFileMock.mock.calls.length;
    const second = await fetchGithubRefStatus('/repo/ref-status-cache', { prs: [7] });
    expect(second.available && second.prs[7]).toBe('merged');
    expect(execFileMock.mock.calls.length).toBe(calls); // nothing spawned the second time
  });

  it('names the conflicting pull requests beside the statuses, and only those', async () => {
    // Both axes in one answer: #7 is `ready` AND unmergeable, #8 is merely ready. `conflicts` is
    // a list rather than a map because the empty case is the normal one.
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'CONFLICTING', commits: { nodes: [] } },
            r1: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', commits: { nodes: [] } },
          },
        },
      }),
    );
    const out = await fetchGithubRefStatus('/repo/ref-status-conflicts', { prs: [7, 8] });

    expect(out.available).toBe(true);
    if (!out.available) throw new Error('expected available');
    expect(out.prs[7]).toBe('ready');
    expect(out.prs[8]).toBe('ready');
    expect(out.conflicts).toEqual([7]);
  });

  it('remembers the conflict alongside the status, so a cached answer still carries both', async () => {
    // The cache stores the resolved reference, not the payload — a second read that spawns
    // nothing must not quietly lose the axis the first one learned.
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'CONFLICTING', commits: { nodes: [] } },
          },
        },
      }),
    );
    await fetchGithubRefStatus('/repo/ref-status-conflict-cache', { prs: [7] });
    const calls = execFileMock.mock.calls.length;
    const cached = await fetchGithubRefStatus('/repo/ref-status-conflict-cache', { prs: [7] });

    expect(execFileMock.mock.calls.length).toBe(calls);
    expect(cached.available && cached.conflicts).toEqual([7]);
  });

  it('keeps every good alias when gh exits non-zero on a PARTIAL failure', async () => {
    // The screenshot bug. `gh api graphql` exits 1 the moment the reply carries an `errors` array,
    // even though `data` holds every alias that DID resolve — so one number that no longer exists
    // used to throw away the whole batch and report an open PR in this very repository as "not
    // found on this repository".
    const partial = JSON.stringify({
      data: {
        repository: {
          r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [] } },
          r1: null,
        },
      },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an issue or pull request with the number of 99999999.' }],
    });
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (argv[0] === 'repo') return cb(null, { stdout: 'owner/n\n', stderr: '' });
      // Exactly what gh does: non-zero exit, the full JSON still on stdout.
      cb(Object.assign(new Error('Command failed'), { code: 1, stdout: partial, stderr: 'gh: Could not resolve…' }), null);
    });

    const out = await fetchGithubRefStatus('/repo/ref-status-partial', { prs: [774, 99999999] });
    expect(out.available).toBe(true);
    if (!out.available) throw new Error('expected available');
    expect(out.prs[774]).toBe('ready');
    expect(99999999 in out.prs).toBe(false);
  });

  it('still degrades when the REPOSITORY itself did not resolve', async () => {
    // A null `repository` is not a partial success — reading it as one would report every number
    // as missing when the truth is that the handle or the token is wrong.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (argv[0] === 'repo') return cb(null, { stdout: 'owner/n\n', stderr: '' });
      cb(
        Object.assign(new Error('Command failed'), {
          code: 1,
          stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: 'NOT_FOUND' }] }),
          stderr: 'gh: Could not resolve to a Repository',
        }),
        null,
      );
    });

    const out = await fetchGithubRefStatus('/repo/ref-status-norepo', { prs: [774] });
    expect(out.available).toBe(false);
  });

  it('never re-asks about a MERGED pull request, and re-asks about a live one', async () => {
    // The refresh policy's whole point: what a reader wants rechecked is what is still moving. A
    // merged PR cannot change (GitHub has no un-merge), so re-asking about it every minute is pure
    // cost — while a running build is the one thing that MUST be re-asked.
    const node = (state: string, rollup: string | null) =>
      JSON.stringify({
        data: {
          repository: {
            r0: {
              __typename: 'PullRequest',
              state,
              isDraft: false,
              reviewDecision: null,
              mergeable: 'MERGEABLE',
              commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: rollup ? { state: rollup } : null } }] },
              reviews: { nodes: [] },
            },
          },
        },
      });

    stubGh(node('MERGED', null));
    expect((await fetchGithubRefStatus('/repo/ttl-merged', { prs: [7] })).available).toBe(true);
    const afterMerged = execFileMock.mock.calls.length;

    stubGh(node('OPEN', 'PENDING'));
    expect((await fetchGithubRefStatus('/repo/ttl-live', { prs: [8] })).available).toBe(true);
    const afterLive = execFileMock.mock.calls.length;

    // Both entries are now 61 s old — past the live TTL, nowhere near the merged one.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await fetchGithubRefStatus('/repo/ttl-merged', { prs: [7] });
    expect(execFileMock.mock.calls.length).toBe(afterLive); // merged: served from cache, no spawn
    await fetchGithubRefStatus('/repo/ttl-live', { prs: [8] });
    expect(execFileMock.mock.calls.length).toBeGreaterThan(afterLive); // live: asked again
    expect(afterMerged).toBeGreaterThan(0);
  });

  it('tells the cockpit when to ask again, from the same table its own cache uses', async () => {
    // Responsibility lives HERE. Whether a status can still move is forge semantics, and the
    // cockpit holds no copy of them — it obeys `recheckAfterMs`. A value the cache would still be
    // serving is a value there is no point asking for, so the two come off one table.
    const pr = (state: string, rollup: string | null) =>
      JSON.stringify({
        data: {
          repository: {
            r0: {
              __typename: 'PullRequest',
              state,
              isDraft: false,
              reviewDecision: null,
              mergeable: 'MERGEABLE',
              commits: { nodes: [{ commit: { committedDate: '2026-08-11T12:00:00Z', statusCheckRollup: rollup ? { state: rollup } : null } }] },
              reviews: { nodes: [] },
            },
          },
        },
      });

    stubGh(pr('OPEN', 'PENDING'));
    const live = await fetchGithubRefStatus('/repo/recheck-live', { prs: [7] });
    expect(live.recheckAfterMs).toBe(60_000); // checks running — ask again in a minute

    stubGh(pr('MERGED', null));
    const merged = await fetchGithubRefStatus('/repo/recheck-merged', { prs: [8] });
    // Immutable: not "in a long while" but "never" — which is what stops the cockpit scheduling.
    expect(merged.recheckAfterMs).toBeNull();

    stubGh(pr('CLOSED', null));
    const closed = await fetchGithubRefStatus('/repo/recheck-closed', { prs: [9] });
    expect(closed.recheckAfterMs).toBe(10 * 60_000); // reopenable, so long rather than never
  });

  it('paces the whole batch by its most changeable reference', () => {
    // One live PR among settled ones has to keep the batch on a clock — the batch is one request,
    // and the soonest anything in it could differ is the soonest the answer could differ.
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'MERGED', isDraft: false, reviewDecision: null, commits: { nodes: [] }, reviews: { nodes: [] } },
            r1: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] }, reviews: { nodes: [] } },
          },
        },
      }),
    );
    return fetchGithubRefStatus('/repo/recheck-mixed', { prs: [7, 8] }).then((out) => {
      expect(out.recheckAfterMs).toBe(60_000);
    });
  });

  // The reported regression, and the reason mergeability is a tri-state rather than a boolean:
  // GitHub COMPUTES it when asked and answers `UNKNOWN` while the job runs, which is the normal
  // reply for the first seconds after every push. Cached as an answer for the usual minute, that
  // is a conflicting pull request wearing "Ready to merge" until the page is reloaded.
  const unknownMergeability = (mergeable: string | null) =>
    JSON.stringify({
      data: {
        repository: {
          r0: {
            __typename: 'PullRequest',
            state: 'OPEN',
            isDraft: false,
            reviewDecision: null,
            mergeable,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
            reviews: { nodes: [] },
          },
        },
      },
    })

  it('comes back in seconds while GitHub is still computing mergeability, not in a minute', async () => {
    stubGh(unknownMergeability('UNKNOWN'));
    const out = await fetchGithubRefStatus('/repo/mergeability-unknown', { prs: [7] });

    expect(out.available).toBe(true);
    if (!out.available) throw new Error('expected available');
    // The status itself is settled and would hold for a minute; the OTHER axis is what is still
    // moving, and the batch travels at the speed of its most impatient member.
    expect(out.prs[7]).toBe('ready');
    expect(out.conflicts).toEqual([]);
    expect(out.recheckAfterMs).toBe(5_000);
  });

  it('and does not cache that non-answer for the usual minute either', async () => {
    stubGh(unknownMergeability('UNKNOWN'));
    await fetchGithubRefStatus('/repo/mergeability-recheck', { prs: [7] });
    const calls = execFileMock.mock.calls.length;

    // Six seconds later the computation has landed. The cache must not still be serving the
    // shrug — this is the read that used to answer "no conflicts" for another 54 seconds.
    vi.advanceTimersByTime(6_000);
    stubGh(unknownMergeability('CONFLICTING'));
    const second = await fetchGithubRefStatus('/repo/mergeability-recheck', { prs: [7] });

    expect(execFileMock.mock.calls.length).toBeGreaterThan(calls);
    expect(second.available && second.conflicts).toEqual([7]);
    // Answered now, so back to the ordinary cadence.
    expect(second.available && second.recheckAfterMs).toBe(60_000);
  });

  it('gives up the fast cadence for a forge that never answers, instead of polling forever', async () => {
    // A five-second poll that outlives the computation it was waiting for is a `gh` subprocess
    // every five seconds, indefinitely, for a repository that is simply never going to say.
    stubGh(unknownMergeability('UNKNOWN'));
    await fetchGithubRefStatus('/repo/mergeability-stuck', { prs: [7] });

    // Past the window, still unknown: the impatience is measured from the FIRST such answer, so
    // it cannot be renewed by the answers that kept it going.
    vi.advanceTimersByTime(61_000);
    const later = await fetchGithubRefStatus('/repo/mergeability-stuck', { prs: [7] });

    expect(later.available && later.recheckAfterMs).toBe(60_000);
  });

  it('asks the cockpit to back off rather than hammer a forge that is not there', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), null);
    });
    const out = await fetchGithubRefStatus('/repo/recheck-nogh', { prs: [7] });
    expect(out.available).toBe(false);
    // Five minutes, not one: a workspace with no `gh` would otherwise spawn a subprocess a minute
    // forever to be told the same thing.
    expect(out.recheckAfterMs).toBe(5 * 60_000);
  });

  it('learns the repo handle once, not once per recheck', async () => {
    // Every tick used to spawn a second subprocess to re-learn an `owner/name` that changes
    // approximately never — doubling the cost of the one query that actually carries information.
    stubGh(JSON.stringify({ data: { repository: { r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] }, reviews: { nodes: [] } } } } }));

    await fetchGithubRefStatus('/repo/handle-memo', { prs: [7] });
    const repoViews = () => execFileMock.mock.calls.filter((call) => (call[1] as string[])[0] === 'repo').length;
    expect(repoViews()).toBe(1);

    // A minute later the status is stale and is re-queried — but the handle is not re-learned.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await fetchGithubRefStatus('/repo/handle-memo', { prs: [7] });
    expect(repoViews()).toBe(1);
    expect(execFileMock.mock.calls.filter((call) => (call[1] as string[])[0] === 'api').length).toBe(2);
  });

  it('re-asks about a reference cezar itself changed', async () => {
    // The self-inflicted staleness: after this server merges a PR, its cached status is a value we
    // KNOW is wrong, and the TTL would hold it for up to a minute. `forgetRefStatus` is what the
    // merge and draft-PR routes call so the next reader pays one query and gets the truth.
    const node = (state: string) =>
      JSON.stringify({
        data: {
          repository: {
            r0: {
              __typename: 'PullRequest',
              state,
              isDraft: false,
              reviewDecision: null,
              commits: { nodes: [] },
              reviews: { nodes: [] },
              reviewRequests: { totalCount: 0 },
            },
          },
        },
      });

    stubGh(node('OPEN'));
    expect((await fetchGithubRefStatus('/repo/forget', { prs: [7] })).available).toBe(true);
    const afterFirst = execFileMock.mock.calls.length;
    // Well inside the TTL: without forgetting, this is served from cache.
    await fetchGithubRefStatus('/repo/forget', { prs: [7] });
    expect(execFileMock.mock.calls.length).toBe(afterFirst);

    forgetRefStatus('/repo/forget', 7);
    stubGh(node('MERGED'));
    const after = await fetchGithubRefStatus('/repo/forget', { prs: [7] });
    expect(execFileMock.mock.calls.length).toBeGreaterThan(afterFirst);
    if (!after.available) throw new Error('expected available');
    expect(after.prs[7]).toBe('merged');
    // …and the cockpit is told to stop polling it, so invalidating REDUCES long-run traffic.
    expect(after.recheckAfterMs).toBeNull();
  });

  it('forgets only the reference named, never the batch', async () => {
    stubGh(
      JSON.stringify({
        data: {
          repository: {
            r0: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [] }, reviews: { nodes: [] }, reviewRequests: { totalCount: 0 } },
            r1: { __typename: 'PullRequest', state: 'OPEN', isDraft: false, reviewDecision: null, commits: { nodes: [] }, reviews: { nodes: [] }, reviewRequests: { totalCount: 0 } },
          },
        },
      }),
    );
    await fetchGithubRefStatus('/repo/forget-one', { prs: [7, 8] });
    forgetRefStatus('/repo/forget-one', 7);

    let askedFor = '';
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      if (argv[0] === 'repo') return cb(null, { stdout: 'owner/n\n', stderr: '' });
      askedFor = argv.join(' ');
      cb(null, { stdout: JSON.stringify({ data: { repository: { r0: null } } }), stderr: '' });
    });
    await fetchGithubRefStatus('/repo/forget-one', { prs: [7, 8] });

    expect(askedFor).toContain('issueOrPullRequest(number: 7)');
    expect(askedFor).not.toContain('issueOrPullRequest(number: 8)');
  });

  it('degrades in the payload when gh is not installed', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, r: unknown) => void;
      cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), null);
    });
    const out = await fetchGithubRefStatus('/repo/ref-status-nogh', { prs: [7] });
    expect(out.available).toBe(false);
    if (out.available) throw new Error('expected unavailable');
    expect(out.reason).toContain('gh CLI not found');
  });
});

describe('refNumberFromUrl', () => {
  it('reads the number a forge URL ends with', () => {
    expect(refNumberFromUrl('https://github.com/o/r/pull/774')).toBe(774);
    expect(refNumberFromUrl('https://github.com/o/r/issues/12/')).toBe(12);
    expect(refNumberFromUrl('  https://github.com/o/r/pull/1  ')).toBe(1);
  });

  it('answers null for a shape it does not recognise, rather than inventing a key', () => {
    // Invalidating the wrong entry is worse than invalidating none: it would evict a status we
    // still hold and leave the changed one cached.
    expect(refNumberFromUrl('https://github.com/o/r/pull/abc')).toBeNull();
    expect(refNumberFromUrl('https://example.com/')).toBeNull();
    expect(refNumberFromUrl('')).toBeNull();
    expect(refNumberFromUrl('https://github.com/o/r/pull/0')).toBeNull();
  });
});
