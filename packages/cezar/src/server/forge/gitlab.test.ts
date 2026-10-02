import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THREAD_ENTRY_CAP, TIMELINE_BUDGET_MS, TIMELINE_EVENT_CAP, TIMELINE_MIN_PAGE_MS } from './github.ts';

// Same technique as github.test.ts: `glab()` builds its runner from `promisify(execFile)` at module
// load, so every probe below is driven through this mock — no real `glab` on the box, no network.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import type { RunRecord } from '../../runs/store.ts';
import { evictForgeProjectCaches } from './cli.ts';
import { GH_CHECKS_MAX, GH_SEARCH_MAX, GithubPrNotFoundError } from './github.ts';
import { parseRemote, type ParsedRemote } from './index.ts';
import { FORGE_PR_DIFF_FILE_CAP, FORGE_PR_PATCH_CAP } from './limits.ts';
import {
  GLAB_NOT_FOUND_REASON,
  createGitlabDriver,
  detectGitlabCached,
  gitlabProjectPath,
  gitlabProjectWebUrl,
} from './gitlab.ts';

/** `glab repo view --output json`, trimmed from a real gitlab.com response (captured 2026-09-22)
 *  to the identity fields plus a few extras the schema must strip; values neutralized. */
const PROJECT_JSON = JSON.stringify({
  id: 1001,
  name: 'demo',
  path_with_namespace: 'acme/demo',
  web_url: 'https://gitlab.com/acme/demo',
  default_branch: 'main',
  visibility: 'public',
  namespace: { id: 7, name: 'acme', path: 'acme', kind: 'group', full_path: 'acme' },
});

/** A realistic `glab` auth failure: the API client's error line, as glab prints it to stderr. */
const GLAB_401 = 'GET https://gitlab.com/api/v4/projects/acme%2Fdemo: 401 {message: 401 Unauthorized}';

/** The same failure as glab 1.118 really prints it (captured live from `glab repo view` with an
 *  invalid token): a padded `ERROR` banner, then the message, wrapped and right-padded. */
const GLAB_118_BOXED_401 =
  '          \n   ERROR  \n          \n  Get https://gitlab.com/api/v4/projects/acme%2Fdemo: 401 {message: 401 \n  Unauthorized}.       \n\n';
const GLAB_118_401_REASON = 'Get https://gitlab.com/api/v4/projects/acme%2Fdemo: 401 {message: 401 Unauthorized}.';

type Callback = (err: unknown, value?: unknown) => void;

const reply = (fn: (cb: Callback) => void) =>
  execFileMock.mockImplementation((...args: unknown[]) => fn(args[args.length - 1] as Callback));

const glabOk = (stdout = PROJECT_JSON) => reply((cb) => cb(null, { stdout, stderr: '' }));

const parsed = (): ParsedRemote => {
  const p = parseRemote('git@gitlab.com:acme/demo.git');
  if (!p) throw new Error('fixture remote must parse');
  return p;
};

let rootSeq = 0;
/** Each case gets its own root, so the module-level caches never leak between cases. */
const freshRoot = () => `/repo/gitlab-detect-${++rootSeq}`;

describe('GitLab driver — detect', () => {
  const CACHE_MS = 60_000; // mirrors the constant in gitlab.ts

  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', ''); // dry-run would short-circuit the probe we're testing
    vi.useFakeTimers();
    vi.setSystemTime(0);
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('is kind gitlab and probes `glab repo view --output json` in the repo root', async () => {
    glabOk();
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    expect(driver.kind).toBe('gitlab');
    expect(await driver.detect()).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execFileMock.mock.calls[0] as [string, string[], { cwd: string; timeout: number }];
    expect(bin).toBe('glab');
    expect(args).toEqual(['repo', 'view', '--output', 'json']);
    expect(opts.cwd).toBe(root);
    expect(opts.timeout).toBe(5_000);
  });

  it('caches the project web_url and path_with_namespace per root on success', async () => {
    glabOk();
    const root = freshRoot();
    expect(gitlabProjectWebUrl(root)).toBeNull();
    await createGitlabDriver(root, parsed()).detect();
    expect(gitlabProjectWebUrl(root)).toBe('https://gitlab.com/acme/demo');
    expect(gitlabProjectPath(root)).toBe('acme/demo');
  });

  it('reports the install hint verbatim when glab is not installed (ENOENT)', async () => {
    reply((cb) => cb(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })));
    const result = await createGitlabDriver(freshRoot(), parsed()).detect();
    expect(result).toEqual({
      available: false,
      reason: 'glab CLI not found — install the GitLab CLI and run `glab auth login`',
    });
    expect(result.reason).toBe(GLAB_NOT_FOUND_REASON);
  });

  it("reports glab's own first stderr line when it is not authenticated", async () => {
    reply((cb) =>
      cb(
        Object.assign(new Error(`Command failed: glab repo view --output json\n${GLAB_401}\n`), {
          code: 1,
          stderr: `\n${GLAB_401}\nRun glab auth login to authenticate.\n`,
        }),
      ),
    );
    const root = freshRoot();
    expect(await createGitlabDriver(root, parsed()).detect()).toEqual({ available: false, reason: GLAB_401 });
    expect(gitlabProjectWebUrl(root)).toBeNull();
  });

  it("reports glab 1.118's boxed error message, never its ERROR banner", async () => {
    reply((cb) => cb(Object.assign(new Error('Command failed: glab repo view --output json'), { code: 1, stderr: GLAB_118_BOXED_401 })));
    expect(await createGitlabDriver(freshRoot(), parsed()).detect()).toEqual({ available: false, reason: GLAB_118_401_REASON });
  });

  it('falls back to the error message, then to "glab failed", when there is no stderr', async () => {
    reply((cb) => cb(Object.assign(new Error('glab timed out'), { code: 1, stderr: '' })));
    expect(await createGitlabDriver(freshRoot(), parsed()).detect()).toEqual({ available: false, reason: 'glab timed out' });

    execFileMock.mockReset();
    reply((cb) => cb(Object.assign(new Error(''), { code: 1 })));
    expect(await createGitlabDriver(freshRoot(), parsed()).detect()).toEqual({ available: false, reason: 'glab failed' });
  });

  it('answers unavailable with a clear reason for malformed or unexpected JSON', async () => {
    glabOk('not json');
    const root = freshRoot();
    expect(await createGitlabDriver(root, parsed()).detect()).toEqual({
      available: false,
      reason: 'glab repo view returned an unexpected response',
    });
    expect(gitlabProjectWebUrl(root)).toBeNull();

    execFileMock.mockReset();
    glabOk(JSON.stringify({ id: 1, name: 'demo' })); // valid JSON, no identity fields
    expect((await createGitlabDriver(freshRoot(), parsed()).detect()).available).toBe(false);
  });

  it('is available under CEZ_DRY_RUN=1 without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    expect(await driver.detect()).toEqual({ available: true });
    expect(driver.detectCached()).toEqual({ available: true });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('detectCached is null when cold, then warm — and never shells out on the read', async () => {
    glabOk();
    const root = freshRoot();
    expect(detectGitlabCached(root)).toBeNull();
    await vi.advanceTimersByTimeAsync(0); // the fire-and-forget probe settles
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(detectGitlabCached(root)).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('serves the stale answer while revalidating once the cache expires (#508)', async () => {
    glabOk();
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    expect(await driver.detect()).toEqual({ available: true });

    vi.setSystemTime(CACHE_MS + 1);
    expect(driver.detectCached()).toEqual({ available: true }); // stale, not null
    await vi.advanceTimersByTimeAsync(0);
    expect(execFileMock).toHaveBeenCalledTimes(2); // exactly one background revalidation
  });

  it('probes once when a cold read is followed by an awaited detect', async () => {
    glabOk();
    const root = freshRoot();
    expect(detectGitlabCached(root)).toBeNull();
    const awaited = createGitlabDriver(root, parsed()).detect();
    await vi.advanceTimersByTimeAsync(0);
    expect(await awaited).toEqual({ available: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('evictForgeProjectCaches drops the probe and the project identity for that root only', async () => {
    glabOk();
    const root = freshRoot();
    const other = freshRoot();
    await createGitlabDriver(root, parsed()).detect();
    await createGitlabDriver(other, parsed()).detect();

    evictForgeProjectCaches(root);
    expect(gitlabProjectWebUrl(root)).toBeNull();
    expect(detectGitlabCached(root)).toBeNull(); // cold again
    expect(detectGitlabCached(other)).toEqual({ available: true });
    expect(gitlabProjectWebUrl(other)).toBe('https://gitlab.com/acme/demo');
  });
});

describe('GitLab driver — skeleton members (later steps implement them)', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses merge-request creation for a run with no worktree/branch (Step 4.1; the rest lives in gitlab-draft-mr.test.ts)', async () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(
      await driver.createPR({ repoRoot: '/repo', run: {} as RunRecord, handoffText: '' }),
    ).toEqual({ ok: false, error: 'this task has no worktree/branch to publish' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('leaves the optional capabilities absent, so the routes degrade in the payload', () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    // listAll (3.2), listComments (3.3), listChecks (3.4), prDiff (3.5) and searchItems (3.6) are
    // now implemented — refStatus stays absent for good (spec Non-goals); prMergeState/mergePR are
    // out of scope for this run entirely.
    expect(driver.refStatus).toBeUndefined();
    expect(driver.prMergeState).toBeUndefined();
    expect(driver.mergePR).toBeUndefined();
  });
});

// ---- listIssues / listPRs / listAll (Step 3.2) ------------------------------------------------
// Fixtures trimmed from real `glab issue/mr list --output json` output against gitlab.com's own
// `gitlab-org/cli` project (captured 2026-09-22), usernames/emails/avatars neutralized. Extra
// fields the real payload carries (`id`, `project_id`, `state`, …) are kept on a couple of rows to
// prove the schema strips them rather than choking on them.
const ISSUES_JSON = JSON.stringify([
  {
    id: 203839552,
    iid: 8564,
    project_id: 34675721,
    title: 'mr note publish --reviewer-state silently does nothing on your own merge request',
    description: 'Publishing your own pending review comments with --reviewer-state silently drops the field.',
    state: 'opened',
    created_at: '2026-09-21T14:52:48.317Z',
    labels: ['type::bug', 'quick win'],
    author: { id: 111, username: 'alice', name: 'Alice Example' },
    user_notes_count: 2,
    web_url: 'https://gitlab.com/acme/demo/-/issues/8564',
  },
  {
    iid: 8563,
    title: 'Support listing and discarding pending review comments',
    description: null,
    created_at: '2026-09-21T12:52:48.714Z',
    labels: [],
    author: { id: 222, username: 'bob' },
    user_notes_count: 0,
    web_url: 'https://gitlab.com/acme/demo/-/issues/8563',
  },
]);

const ISSUES_ITEMS = [
  {
    kind: 'issue',
    number: 8564,
    title: 'mr note publish --reviewer-state silently does nothing on your own merge request',
    author: 'alice',
    createdAt: '2026-09-21T14:52:48.317Z',
    labels: ['type::bug', 'quick win'],
    body: 'Publishing your own pending review comments with --reviewer-state silently drops the field.',
    url: 'https://gitlab.com/acme/demo/-/issues/8564',
    comments: 2,
  },
  {
    kind: 'issue',
    number: 8563,
    title: 'Support listing and discarding pending review comments',
    author: 'bob',
    createdAt: '2026-09-21T12:52:48.714Z',
    labels: [],
    body: '',
    url: 'https://gitlab.com/acme/demo/-/issues/8563',
    comments: 0,
  },
];

const MRS_JSON = JSON.stringify([
  {
    id: 536356170,
    iid: 3950,
    project_id: 34675721,
    title: 'feat: delegate path ownership to domain teams without Maintainer',
    description: 'Adds a code owner group for the delegated paths and documents the access model.',
    state: 'opened',
    created_at: '2026-09-21T19:16:00.183Z',
    labels: ['type::maintenance'],
    author: { id: 111, username: 'alice' },
    user_notes_count: 2,
    web_url: 'https://gitlab.com/acme/demo/-/merge_requests/3950',
    draft: true,
    work_in_progress: false,
  },
  {
    // Legacy MRs that predate the `draft` field still only set `work_in_progress`.
    iid: 3948,
    title: 'docs(agents): drop the removed gen-config command',
    description: 'Removes a stale command reference from AGENTS.md.',
    created_at: '2026-09-21T16:38:16.412Z',
    labels: [],
    author: { id: 333, username: 'carol' },
    user_notes_count: 1,
    web_url: 'https://gitlab.com/acme/demo/-/merge_requests/3948',
    draft: false,
    work_in_progress: true,
  },
  {
    iid: 3945,
    title: 'test(mr): scope the mr note publish integration test to API contract',
    description: '',
    created_at: '2026-09-21T14:17:10.114Z',
    labels: [],
    author: null,
    user_notes_count: 4,
    web_url: 'https://gitlab.com/acme/demo/-/merge_requests/3945',
    draft: false,
    work_in_progress: false,
  },
]);

const MRS_ITEMS = [
  {
    kind: 'pr',
    number: 3950,
    title: 'feat: delegate path ownership to domain teams without Maintainer',
    author: 'alice',
    createdAt: '2026-09-21T19:16:00.183Z',
    labels: ['type::maintenance'],
    body: 'Adds a code owner group for the delegated paths and documents the access model.',
    url: 'https://gitlab.com/acme/demo/-/merge_requests/3950',
    comments: 2,
    isDraft: true,
    checks: null,
  },
  {
    kind: 'pr',
    number: 3948,
    title: 'docs(agents): drop the removed gen-config command',
    author: 'carol',
    createdAt: '2026-09-21T16:38:16.412Z',
    labels: [],
    body: 'Removes a stale command reference from AGENTS.md.',
    url: 'https://gitlab.com/acme/demo/-/merge_requests/3948',
    comments: 1,
    isDraft: true, // legacy `work_in_progress`, no `draft` field set
    checks: null,
  },
  {
    kind: 'pr',
    number: 3945,
    title: 'test(mr): scope the mr note publish integration test to API contract',
    author: '?',
    createdAt: '2026-09-21T14:17:10.114Z',
    labels: [],
    body: '',
    url: 'https://gitlab.com/acme/demo/-/merge_requests/3945',
    comments: 4,
    isDraft: false,
    checks: null,
  },
];

const LABELS_JSON = JSON.stringify([
  { name: 'type::bug', color: '#d73a4a' },
  { name: 'type::maintenance', color: '#6699cc' },
]);

/** Routes `glab <cmd> …` calls by their first argument (`issue` / `mr` / `api`) to a canned
 *  stdout, or a stderr-carrying failure when the case wants one to fail. A command with no
 *  handler answers a plain command failure — the labels-endpoint-failure case relies on this. */
function routeGlab(handlers: Partial<Record<string, string | { fail: string }>>) {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const cliArgs = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as Callback;
    const handler = handlers[cliArgs[0] ?? ''];
    if (handler === undefined) {
      cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: 'glab: unknown command\n' }));
      return;
    }
    if (typeof handler === 'string') {
      cb(null, { stdout: handler, stderr: '' });
      return;
    }
    cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: `${handler.fail}\n` }));
  });
}

/** Every case in this block gets its own root, and every arg-based call site is captured, so
 *  cases never leak into each other through the module-level list cache. */
describe('GitLab driver — listIssues / listPRs / listAll', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps a fixture issue list to the exact ForgeItem[] (iid → number, extras stripped)', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: '[]', api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listIssues()).toEqual(ISSUES_ITEMS);
  });

  it('maps a fixture MR list, draft via `draft` and via legacy `work_in_progress`', async () => {
    routeGlab({ issue: '[]', mr: MRS_JSON, api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listPRs()).toEqual(MRS_ITEMS);
  });

  it('listAll serves the whole payload — repo, syncedAt, both sets and label colors', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: MRS_JSON, api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listAll!();
    expect(data).toEqual({
      available: true,
      repo: 'acme/demo',
      syncedAt: expect.any(String),
      issues: ISSUES_ITEMS,
      prs: MRS_ITEMS,
      labelColors: { 'type::bug': 'd73a4a', 'type::maintenance': '6699cc' },
    });
  });

  it('an empty issue and MR list answers empty arrays, still available', async () => {
    routeGlab({ issue: '[]', mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({
      available: true,
      repo: 'acme/demo',
      syncedAt: expect.any(String),
      issues: [],
      prs: [],
      labelColors: {},
    });
  });

  it('clamps a limit above the per-page ceiling and passes it to both `glab` calls', async () => {
    routeGlab({ issue: '[]', mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    await driver.listAll!({ limit: 5_000 });
    const issueCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'issue');
    const mrCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'mr');
    expect(issueCall?.[1]).toEqual(['issue', 'list', '--output', 'json', '--per-page', '100']);
    expect(mrCall?.[1]).toEqual(['mr', 'list', '--output', 'json', '--per-page', '100']);
  });

  it('a malformed issue list answers unavailable with a clear reason', async () => {
    routeGlab({ issue: 'not json', mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({
      available: false,
      reason: 'glab issue list returned an unexpected response',
      issues: [],
      prs: [],
    });
  });

  it('a malformed MR list answers unavailable with a clear reason', async () => {
    routeGlab({ issue: '[]', mr: JSON.stringify([{ iid: 'not-a-number' }]), api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({
      available: false,
      reason: 'glab mr list returned an unexpected response',
      issues: [],
      prs: [],
    });
  });

  it('a glab CLI failure on the list calls answers unavailable with its own first stderr line', async () => {
    routeGlab({ issue: { fail: GLAB_401 }, mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({ available: false, reason: GLAB_401, issues: [], prs: [] });
  });

  it("a glab 1.118 boxed failure on the list calls answers with the message, not the banner", async () => {
    routeGlab({ issue: { fail: GLAB_118_BOXED_401 }, mr: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listAll!()).toEqual({ available: false, reason: GLAB_118_401_REASON, issues: [], prs: [] });
  });

  it('a labels endpoint failure leaves the list available without labelColors', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: MRS_JSON }); // no `api` handler — labels call fails
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listAll!();
    expect(data.available).toBe(true);
    expect(data.issues).toEqual(ISSUES_ITEMS);
    expect(data.labelColors).toBeUndefined();
  });

  it('caches the listing per root; refresh bypasses it', async () => {
    routeGlab({ issue: ISSUES_JSON, mr: '[]', api: '[]' });
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    const first = await driver.listAll!();
    expect(first.issues).toHaveLength(2);

    routeGlab({ issue: '[]', mr: '[]', api: '[]' }); // the "server" changed underneath the cache
    expect(await driver.listAll!()).toEqual(first); // served from cache, not refetched

    const refreshed = await driver.listAll!({ refresh: true });
    expect(refreshed.issues).toEqual([]);
  });

  it('is available under CEZ_DRY_RUN=1 with a demo catalog, without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    // Each dry-run call builds its catalog from the clock; freeze it so the three calls below
    // compare equal instead of racing a millisecond boundary.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    try {
      const driver = createGitlabDriver(freshRoot(), parsed());
      const data = await driver.listAll!();
      expect(data.available).toBe(true);
      expect(data.repo).toBe('demo/demo');
      expect(data.issues).toHaveLength(1);
      expect(data.prs).toEqual([expect.objectContaining({ isDraft: true, checks: null, url: expect.stringContaining('gitlab.com/demo/demo') })]);
      expect(await driver.listIssues()).toEqual(data.issues);
      expect(await driver.listPRs()).toEqual(data.prs);
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- listComments with timeline events (Step 3.3) ---------------------------------------------
// Notes trimmed from a real `glab api …/notes` response against gitlab.com's own `gitlab-org/cli`
// project (captured 2026-09-22), usernames/avatars neutralized; the label-event row mirrors a real
// `resource_label_events` capture the same way. `resource_state_events` was not in the original
// capture, so those rows are synthesized in the documented REST shape
// (`{id, user, created_at, state, resource_type, resource_id}`).

const NOTE_COMMENT = {
  id: 1001,
  body: 'Thanks for reviewing — updated per your suggestion.',
  author: { username: 'alice', avatar_url: 'https://example.com/avatars/alice.png' },
  created_at: '2026-09-21T14:00:00.000Z',
  system: false,
};
const NOTE_ASSIGNED = {
  id: 1002,
  body: 'assigned to @bob',
  author: { username: 'alice' },
  created_at: '2026-09-21T14:05:00.000Z',
  system: true,
};
const NOTE_UNASSIGNED = {
  id: 1003,
  body: 'unassigned @bob',
  author: { username: 'alice' },
  created_at: '2026-09-21T14:06:00.000Z',
  system: true,
};
// Real system notes for a title change carry an HTML diff of the old/new value — trimmed from the
// captured fixture's markup shape, values neutralized.
const NOTE_RENAMED = {
  id: 1004,
  body: '<p>changed title from <code class="idiff"><span class="idiff left right deletion">old title</span></code> to <code class="idiff"><span class="idiff left right addition">new title</span></code></p>',
  author: { username: 'alice' },
  created_at: '2026-09-21T14:07:00.000Z',
  system: true,
};
const NOTE_UNMAPPED_COMMIT = {
  id: 1005,
  body: 'added 1 commit\n\n<ul><li>abc1234 - fix stuff</li></ul>',
  author: { username: 'alice' },
  created_at: '2026-09-21T14:08:00.000Z',
  system: true,
};
const NOTE_UNMAPPED_REVIEW_REQUEST = {
  id: 1006,
  body: 'requested review from @carol',
  author: { username: 'alice' },
  created_at: '2026-09-21T14:09:00.000Z',
  system: true,
};

const LABEL_EVENT_ADD = {
  id: 2001,
  user: { username: 'alice', avatar_url: 'https://example.com/avatars/alice.png' },
  created_at: '2026-09-21T14:01:00.000Z',
  action: 'add',
  label: { name: 'bug', color: '#d73a4a' },
};
const LABEL_EVENT_REMOVE = {
  id: 2002,
  user: { username: 'bob' },
  created_at: '2026-09-21T14:02:00.000Z',
  action: 'remove',
  label: { name: 'bug', color: '#d73a4a' },
};

const STATE_EVENT_CLOSED = { id: 3001, user: { username: 'alice' }, created_at: '2026-09-21T14:03:00.000Z', state: 'closed' };
const STATE_EVENT_REOPENED = { id: 3002, user: { username: 'alice' }, created_at: '2026-09-21T14:04:00.000Z', state: 'reopened' };
const STATE_EVENT_MERGED = { id: 3003, user: { username: 'alice' }, created_at: '2026-09-21T14:10:00.000Z', state: 'merged' };
const STATE_EVENT_UNKNOWN = { id: 3004, user: { username: 'alice' }, created_at: '2026-09-21T14:11:00.000Z', state: 'draft' };

type ApiHandler = ((page: number) => unknown) | { fail: string };

/** Routes `glab api <path>` calls by a substring of the path (`/notes`, `/resource_label_events`,
 *  `/resource_state_events`) to a per-page responder, so a test can drive the bounded page loop
 *  for each endpoint independently. A path with no matching handler answers a plain command
 *  failure — the "resource-events endpoint failing" cases rely on this. */
function routeGlabApi(handlers: Partial<Record<'notes' | 'resource_label_events' | 'resource_state_events', ApiHandler>>) {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const cliArgs = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as Callback;
    const path = cliArgs[1] ?? '';
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
    const key = (['notes', 'resource_label_events', 'resource_state_events'] as const).find((k) => path.includes(`/${k}`));
    const handler = key ? handlers[key] : undefined;
    if (handler === undefined) {
      cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: 'glab: unknown command\n' }));
      return;
    }
    if (typeof handler === 'function') {
      cb(null, { stdout: JSON.stringify(handler(page)), stderr: '' });
      return;
    }
    cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: `${handler.fail}\n` }));
  });
}

/** A page-aware responder over a fixed row set — every case below has under 100 rows (one page)
 *  except the caps test, which relies on this to serve real pagination. */
const paged = (rows: unknown[]) => (page: number) => rows.slice((page - 1) * 100, page * 100);

describe('GitLab driver — listComments with timeline events', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps a user note to the exact ForgeComment, MR url grammar', async () => {
    routeGlabApi({ notes: paged([NOTE_COMMENT]), resource_label_events: paged([]), resource_state_events: paged([]) });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    expect(data.available).toBe(true);
    expect(data.comments).toEqual([
      {
        id: 1001,
        author: 'alice',
        avatarUrl: 'https://example.com/avatars/alice.png',
        createdAt: '2026-09-21T14:00:00.000Z',
        body: 'Thanks for reviewing — updated per your suggestion.',
        kind: 'comment',
        url: 'https://gitlab.com/acme/demo/-/merge_requests/3950#note_1001',
      },
    ]);
  });

  it('builds an issue comment url with the /-/issues/ grammar', async () => {
    routeGlabApi({ notes: paged([NOTE_COMMENT]), resource_label_events: paged([]), resource_state_events: paged([]) });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('issue', 8564);
    expect(data.comments[0]!.url).toBe('https://gitlab.com/acme/demo/-/issues/8564#note_1001');
  });

  it('maps every event kind: labeled, unlabeled, closed, reopened, merged, assigned, unassigned, renamed', async () => {
    routeGlabApi({
      notes: paged([NOTE_ASSIGNED, NOTE_UNASSIGNED, NOTE_RENAMED]),
      resource_label_events: paged([LABEL_EVENT_ADD, LABEL_EVENT_REMOVE]),
      resource_state_events: paged([STATE_EVENT_CLOSED, STATE_EVENT_REOPENED, STATE_EVENT_MERGED]),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    const byKind = Object.fromEntries((data.events ?? []).map((e) => [e.kind, e]));
    expect(byKind.labeled).toMatchObject({
      id: 'evt-2001',
      actor: 'alice',
      avatarUrl: 'https://example.com/avatars/alice.png',
      label: { name: 'bug', color: 'd73a4a' },
    });
    expect(byKind.unlabeled).toMatchObject({ id: 'evt-2002', actor: 'bob', label: { name: 'bug', color: 'd73a4a' } });
    expect(byKind.closed).toMatchObject({ id: 'evt-3001', actor: 'alice' });
    expect(byKind.reopened).toMatchObject({ id: 'evt-3002', actor: 'alice' });
    expect(byKind.merged).toMatchObject({ id: 'evt-3003', actor: 'alice' });
    expect(byKind.assigned).toMatchObject({ id: 'evt-1002', actor: 'alice', subject: 'bob' });
    expect(byKind.unassigned).toMatchObject({ id: 'evt-1003', actor: 'alice', subject: 'bob' });
    expect(byKind.renamed).toMatchObject({ id: 'evt-1004', actor: 'alice', subject: 'new title' });
    expect(data.events).toHaveLength(8);
  });

  it('leaves no markup in a renamed subject, however the note nests or splits its tags', async () => {
    // Guard, not a regression test: a single strip pass already reaches the fixpoint for this
    // regex. It pins that a hostile title rename yields text, never a reassembled tag.
    routeGlabApi({
      notes: paged([{ ...NOTE_RENAMED, body: '<p>changed title from a to <scr<b>ipt>x</scr<i>ipt><<b>img src=y></p>' }]),
      resource_label_events: paged([]),
      resource_state_events: paged([]),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    const subject = data.events?.find((e) => e.kind === 'renamed')?.subject;
    expect(subject).toBeDefined();
    expect(subject).not.toMatch(/<[^>]*>/);
  });

  it('drops an unmapped system note and an unknown state event', async () => {
    routeGlabApi({
      notes: paged([NOTE_UNMAPPED_COMMIT, NOTE_UNMAPPED_REVIEW_REQUEST]),
      resource_label_events: paged([]),
      resource_state_events: paged([STATE_EVENT_UNKNOWN]),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    expect(data.comments).toEqual([]);
    expect(data.events).toEqual([]);
  });

  it('orders comments and events chronologically regardless of arrival order', async () => {
    const late = { ...NOTE_COMMENT, id: 1, created_at: '2026-09-21T15:00:00.000Z' };
    const early = { ...NOTE_COMMENT, id: 2, created_at: '2026-09-21T13:00:00.000Z' };
    routeGlabApi({
      notes: paged([late, early]),
      resource_label_events: paged([LABEL_EVENT_REMOVE, LABEL_EVENT_ADD]), // remove is later than add
      resource_state_events: paged([]),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    expect(data.comments.map((c) => c.id)).toEqual([2, 1]);
    expect(data.events!.map((e) => e.id)).toEqual(['evt-2001', 'evt-2002']);
  });

  it('caps comments at THREAD_ENTRY_CAP keeping the oldest, events at TIMELINE_EVENT_CAP keeping the newest', async () => {
    const manyComments = Array.from({ length: THREAD_ENTRY_CAP + 10 }, (_, i) => ({
      id: i + 1,
      body: `comment ${i + 1}`,
      author: { username: 'alice' },
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      system: false,
    }));
    const manyLabelEvents = Array.from({ length: TIMELINE_EVENT_CAP + 10 }, (_, i) => ({
      id: i + 1,
      user: { username: 'alice' },
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      action: 'add',
      label: { name: `l${i}` },
    }));
    routeGlabApi({
      notes: paged(manyComments),
      resource_label_events: paged(manyLabelEvents),
      resource_state_events: paged([]),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 1);
    expect(data.comments).toHaveLength(THREAD_ENTRY_CAP);
    expect(data.comments[0]!.id).toBe(1); // oldest kept
    expect(data.events).toHaveLength(TIMELINE_EVENT_CAP);
    expect(data.events![data.events!.length - 1]!.id).toBe(`evt-${TIMELINE_EVENT_CAP + 10}`); // newest kept
    expect(data.truncated).toBe(true);
  });

  it('a resource-events endpoint failing leaves comments intact and events absent', async () => {
    routeGlabApi({
      notes: paged([NOTE_COMMENT]),
      resource_state_events: paged([]),
      // no `resource_label_events` handler — that endpoint fails
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    expect(data.available).toBe(true);
    expect(data.comments).toHaveLength(1);
    expect(data.events).toBeUndefined();
  });

  it('reports the install hint when glab is not installed (ENOENT) on the notes call', async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as Callback;
      cb(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }));
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    expect(data).toEqual({ available: false, reason: GLAB_NOT_FOUND_REASON, comments: [] });
  });

  it("a notes page-1 failure answers unavailable with glab's own first stderr line", async () => {
    routeGlabApi({ notes: { fail: GLAB_401 } });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    expect(data).toEqual({ available: false, reason: GLAB_401, comments: [] });
  });

  it('a malformed notes payload answers unavailable with a clear reason', async () => {
    routeGlabApi({ notes: () => [{ id: 'not-a-number' }], resource_label_events: paged([]), resource_state_events: paged([]) });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('pr', 3950);
    expect(data).toEqual({ available: false, reason: 'glab api notes returned an unexpected response', comments: [] });
  });

  it('caches the thread per root/kind/number; refresh bypasses it', async () => {
    routeGlabApi({ notes: paged([NOTE_COMMENT]), resource_label_events: paged([]), resource_state_events: paged([]) });
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    const first = await driver.listComments!('pr', 3950);
    expect(first.comments).toHaveLength(1);

    routeGlabApi({ notes: paged([]), resource_label_events: paged([]), resource_state_events: paged([]) }); // "server" changed
    expect(await driver.listComments!('pr', 3950)).toEqual(first); // served from cache

    const refreshed = await driver.listComments!('pr', 3950, { refresh: true });
    expect(refreshed.comments).toEqual([]);
  });

  it('is available under CEZ_DRY_RUN=1 with a demo thread, without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listComments!('issue', 1);
    expect(data.available).toBe(true);
    expect(data.comments).toHaveLength(1);
    expect(data.events).toHaveLength(1);
    expect(data.events![0]!.kind).toBe('labeled');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ---- listChecks / prStatus (Step 3.4) ----------------------------------------------------------
// `glab api projects/:fullpath/merge_requests/:iid` is the ONLY endpoint either capability reads —
// `glab mr list` payloads never carry the pipeline (Drift note, spec
// 2026-08-10-forge-provider-adapters). `mrDetail` builds the fixture shape for that endpoint;
// `routeGlabMr` answers both it (`api`) and the branch probe (`mr list`).

/** `head_pipeline` fixture shapes: `undefined` → the field is absent (no pipeline ever ran, the
 *  real shape a brand-new MR reports), `null` → present but explicitly null (glab also does this),
 *  a string → `{status}`. Both `undefined` and `null` map to the same "no glyph" answer. */
const mrDetail = (pipelineStatus?: string | null): string =>
  JSON.stringify(
    pipelineStatus === undefined ? {} : { head_pipeline: pipelineStatus === null ? null : { status: pipelineStatus } },
  );

type MrHandler = string | { fail: string };

/** Routes `glab mr list --source-branch … --all --output json` to `mrList`, and `glab api
 *  projects/:fullpath/merge_requests/:iid` to `details[iid]`, by inspecting the call's own args —
 *  same technique as `routeGlab`/`routeGlabApi` above. An MR id with no handler answers glab's own
 *  404 line, matching what `glab api` prints for an id that doesn't exist. */
function routeGlabMr(handlers: { mrList?: MrHandler; details?: Record<number, MrHandler>; advanceMs?: number }) {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const cliArgs = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as Callback;
    // A slow instance, on the fake clock: every call costs `advanceMs` of the fan-out's budget.
    if (handlers.advanceMs) vi.setSystemTime(Date.now() + handlers.advanceMs);
    const respond = (handler: MrHandler | undefined, notFoundStderr: string) => {
      if (handler === undefined) {
        cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: `${notFoundStderr}\n` }));
        return;
      }
      if (typeof handler === 'string') {
        cb(null, { stdout: handler, stderr: '' });
        return;
      }
      cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: `${handler.fail}\n` }));
    };
    if (cliArgs[0] === 'mr' && cliArgs[1] === 'list') {
      respond(handlers.mrList, 'glab: unknown command');
      return;
    }
    if (cliArgs[0] === 'api') {
      const path = cliArgs[1] ?? '';
      const iid = Number(/merge_requests\/(\d+)/.exec(path)?.[1] ?? NaN);
      respond(handlers.details?.[iid], 'glab: 404 Not Found (HTTP 404)');
      return;
    }
    cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: 'glab: unknown command\n' }));
  });
}

describe('GitLab driver — listChecks', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps every pipeline status to its glyph, and a missing head_pipeline to null', async () => {
    routeGlabMr({
      details: {
        1: mrDetail('success'),
        2: mrDetail('failed'),
        3: mrDetail('running'),
        4: mrDetail('pending'),
        5: mrDetail('created'),
        6: mrDetail('waiting_for_resource'),
        7: mrDetail('preparing'),
        8: mrDetail('scheduled'),
        9: mrDetail('canceled'),
        10: mrDetail('canceling'),
        11: mrDetail('skipped'),
        12: mrDetail('manual'),
        13: mrDetail(undefined), // no head_pipeline at all
        14: mrDetail(null), // head_pipeline explicitly null
      },
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listChecks!([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(data).toEqual({
      available: true,
      checks: {
        1: 'passing',
        2: 'failing',
        3: 'pending',
        4: 'pending',
        5: 'pending',
        6: 'pending',
        7: 'pending',
        8: 'pending',
        9: null,
        10: null,
        11: null,
        12: null,
        13: null,
        14: null,
      },
    });
  });

  it('omits a single non-first MR that fails, leaving the rest available', async () => {
    routeGlabMr({ details: { 1: mrDetail('success'), 3: mrDetail('failed') } }); // 2 has no handler → fails
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.listChecks!([1, 2, 3]);
    expect(data.available).toBe(true);
    if (!data.available) throw new Error('expected available');
    expect(data.checks).toEqual({ 1: 'passing', 3: 'failing' });
    expect(2 in data.checks).toBe(false);
  });

  it('caps at GH_CHECKS_MAX, de-duplicates and drops non-positive numbers', async () => {
    const details: Record<number, MrHandler> = {};
    for (let n = 1; n <= GH_CHECKS_MAX + 5; n++) details[n] = mrDetail('success');
    routeGlabMr({ details });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const many = Array.from({ length: GH_CHECKS_MAX + 5 }, (_, i) => i + 1);
    const data = await driver.listChecks!([...many, ...many, 0, -1]);
    expect(data.available).toBe(true);
    if (!data.available) throw new Error('expected available');
    expect(Object.keys(data.checks)).toHaveLength(GH_CHECKS_MAX);
  });

  it('answers unavailable when the FIRST call fails with ENOENT (glab not installed)', async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as Callback;
      cb(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }));
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listChecks!([1, 2])).toEqual({ available: false, reason: GLAB_NOT_FOUND_REASON });
  });

  it("answers unavailable with glab's own reason when the FIRST call fails (e.g. unauthenticated)", async () => {
    routeGlabMr({ details: { 1: { fail: GLAB_401 } } });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listChecks!([1, 2])).toEqual({ available: false, reason: GLAB_401 });
  });

  it('an empty or all-invalid numbers list answers an empty map without shelling out', async () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listChecks!([])).toEqual({ available: true, checks: {} });
    expect(await driver.listChecks!([0, -1])).toEqual({ available: true, checks: {} });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('caches a resolved glyph per root; a second call serves it without shelling out again', async () => {
    routeGlabMr({ details: { 1: mrDetail('success') } });
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    expect(await driver.listChecks!([1])).toEqual({ available: true, checks: { 1: 'passing' } });
    const callsAfterFirst = execFileMock.mock.calls.length;
    routeGlabMr({ details: { 1: mrDetail('failed') } }); // "server" changed underneath the cache
    expect(await driver.listChecks!([1])).toEqual({ available: true, checks: { 1: 'passing' } });
    expect(execFileMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('evictForgeProjectCaches drops the cached glyphs for that root only', async () => {
    routeGlabMr({ details: { 1: mrDetail('success') } });
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    await driver.listChecks!([1]);
    evictForgeProjectCaches(root);
    routeGlabMr({ details: { 1: mrDetail('failed') } });
    expect(await driver.listChecks!([1])).toEqual({ available: true, checks: { 1: 'failing' } });
  });

  it('is available under CEZ_DRY_RUN=1 with a demo glyph, without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.listChecks!([1, 2])).toEqual({ available: true, checks: { 1: 'passing', 2: null } });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // The fan-out has ONE deadline, like every other multi-call GitLab path (`fetchBoundedPages`).
  // Before it, `GH_CHECKS_MAX` (100) detail calls each carried their own ~10 s timeout with nothing
  // shared, so a slow instance could hold `GET /github/checks` open for minutes.
  describe('shared deadline', () => {
    const NUMBERS = Array.from({ length: 40 }, (_, i) => i + 1);
    const allDetails = (): Record<number, MrHandler> =>
      Object.fromEntries(NUMBERS.map((n) => [n, mrDetail('success')] as const));

    beforeEach(() => {
      // Only Date: the fan-out awaits real promises, and faking timers wholesale would stall them.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(0);
    });
    afterEach(() => vi.useRealTimers());

    it('stops issuing detail calls at the budget and returns the glyphs resolved so far', async () => {
      const perCall = TIMELINE_MIN_PAGE_MS; // a deliberately slow instance
      routeGlabMr({ details: allDetails(), advanceMs: perCall });
      const driver = createGitlabDriver(freshRoot(), parsed());
      const data = await driver.listChecks!(NUMBERS);

      expect(data.available).toBe(true);
      if (!data.available) throw new Error('expected available');
      const resolved = Object.keys(data.checks);
      // Partial, not empty and not everything — the rows whose glyph never came back are simply
      // ABSENT from the map, which is `ForgeChecksData`'s "nothing is known".
      expect(resolved.length).toBeGreaterThan(0);
      expect(resolved.length).toBeLessThan(NUMBERS.length);
      for (const key of resolved) expect(NUMBERS).toContain(Number(key));
      // One `glab` process per resolved glyph — the rest were never spawned.
      expect(execFileMock.mock.calls.length).toBe(resolved.length);
      // And the whole fan-out fits the budget, give or take the call that was in flight when it ran
      // out — never `numbers.length * 10 s`.
      expect(Date.now()).toBeLessThanOrEqual(TIMELINE_BUDGET_MS + perCall);
    });

    it('hands each call the smaller of its own ceiling and what is left of the budget', async () => {
      routeGlabMr({ details: allDetails(), advanceMs: TIMELINE_MIN_PAGE_MS });
      const driver = createGitlabDriver(freshRoot(), parsed());
      await driver.listChecks!(NUMBERS);
      const timeouts = execFileMock.mock.calls.map((call: unknown[]) => (call[2] as { timeout?: number }).timeout ?? 0);
      expect(timeouts.length).toBeGreaterThan(1);
      for (const timeout of timeouts) {
        expect(timeout).toBeGreaterThanOrEqual(TIMELINE_MIN_PAGE_MS);
        expect(timeout).toBeLessThanOrEqual(10_000); // MR_DETAIL_TIMEOUT_MS, the per-call ceiling
      }
      // Monotonically non-increasing: every call shares one shrinking budget.
      expect([...timeouts].sort((a: number, b: number) => b - a)).toEqual(timeouts);
    });

    it('leaves the fast path untouched — a responsive instance resolves every glyph', async () => {
      routeGlabMr({ details: allDetails(), advanceMs: 5 });
      const driver = createGitlabDriver(freshRoot(), parsed());
      const data = await driver.listChecks!(NUMBERS);
      expect(data.available).toBe(true);
      if (!data.available) throw new Error('expected available');
      expect(Object.keys(data.checks)).toHaveLength(NUMBERS.length);
      expect(Object.values(data.checks).every((glyph) => glyph === 'passing')).toBe(true);
    });
  });
});

describe('GitLab driver — prStatus', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const mrRow = (iid: number, state: string, extra: Partial<{ draft: boolean; work_in_progress: boolean }> = {}) => ({
    iid,
    web_url: `https://gitlab.com/acme/demo/-/merge_requests/${iid}`,
    state,
    draft: extra.draft ?? false,
    work_in_progress: extra.work_in_progress ?? false,
  });

  it('maps state opened → open, with its pipeline glyph', async () => {
    routeGlabMr({ mrList: JSON.stringify([mrRow(10, 'opened')]), details: { 10: mrDetail('success') } });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.prStatus('feature')).toEqual({
      number: 10,
      url: 'https://gitlab.com/acme/demo/-/merge_requests/10',
      state: 'open',
      isDraft: false,
      checks: 'passing',
    });
  });

  it('maps state merged → merged, and closed/locked → closed', async () => {
    routeGlabMr({ mrList: JSON.stringify([mrRow(11, 'merged')]), details: {} });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect((await driver.prStatus('feature'))?.state).toBe('merged');

    execFileMock.mockReset();
    routeGlabMr({ mrList: JSON.stringify([mrRow(12, 'closed')]), details: {} });
    expect((await createGitlabDriver(freshRoot(), parsed()).prStatus('feature'))?.state).toBe('closed');

    execFileMock.mockReset();
    routeGlabMr({ mrList: JSON.stringify([mrRow(13, 'locked')]), details: {} });
    expect((await createGitlabDriver(freshRoot(), parsed()).prStatus('feature'))?.state).toBe('closed');
  });

  it('isDraft is true via either `draft` or legacy `work_in_progress`', async () => {
    routeGlabMr({ mrList: JSON.stringify([mrRow(14, 'opened', { draft: true })]), details: {} });
    expect((await createGitlabDriver(freshRoot(), parsed()).prStatus('feature'))?.isDraft).toBe(true);

    execFileMock.mockReset();
    routeGlabMr({ mrList: JSON.stringify([mrRow(15, 'opened', { work_in_progress: true })]), details: {} });
    expect((await createGitlabDriver(freshRoot(), parsed()).prStatus('feature'))?.isDraft).toBe(true);
  });

  it('picks the highest iid when several MRs share the branch', async () => {
    routeGlabMr({
      mrList: JSON.stringify([mrRow(20, 'closed'), mrRow(25, 'opened'), mrRow(22, 'merged')]),
      details: {},
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect((await driver.prStatus('feature'))?.number).toBe(25);
  });

  it('no head_pipeline on the chosen MR answers checks: null', async () => {
    routeGlabMr({ mrList: JSON.stringify([mrRow(30, 'opened')]), details: { 30: mrDetail(undefined) } });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect((await driver.prStatus('feature'))?.checks).toBeNull();
  });

  it("a failing detail call still answers the MR, with checks: null (the glyph is a bonus)", async () => {
    routeGlabMr({ mrList: JSON.stringify([mrRow(31, 'opened')]), details: {} }); // 31 has no detail handler → fails
    const driver = createGitlabDriver(freshRoot(), parsed());
    const status = await driver.prStatus('feature');
    expect(status?.number).toBe(31);
    expect(status?.checks).toBeNull();
  });

  it('a branch with no MR answers null', async () => {
    routeGlabMr({ mrList: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.prStatus('feature')).toBeNull();
  });

  it('any glab failure on the branch probe answers null, not a throw', async () => {
    routeGlabMr({ mrList: { fail: GLAB_401 } });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.prStatus('feature')).toBeNull();

    execFileMock.mockReset();
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as Callback;
      cb(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }));
    });
    expect(await createGitlabDriver(freshRoot(), parsed()).prStatus('feature')).toBeNull();
  });

  it('is null under CEZ_DRY_RUN=1, mirroring GitHub, without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.prStatus('feature')).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('calls `glab mr list --source-branch <branch> --all --output json` with the given branch', async () => {
    routeGlabMr({ mrList: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    await driver.prStatus('feature/my-branch');
    const call = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'mr');
    expect(call?.[1]).toEqual(['mr', 'list', '--source-branch', 'feature/my-branch', '--all', '--output', 'json']);
  });
});

// ---- prDiff (Step 3.5) --------------------------------------------------------------------------
// `glab api projects/:fullpath/merge_requests/:iid` supplies `sha` (the head commit); the paged
// `…/diffs` endpoint (NOT the deprecated `/changes`) supplies the files. `routeGlabPrDiff` answers
// both by inspecting whether the `api` call's path carries `/diffs`.

const mrDetailSha = (sha: string): string => JSON.stringify({ sha });

type DiffsHandler = ((page: number) => unknown[]) | { fail: string };

function routeGlabPrDiff(handlers: { detail?: MrHandler; diffs?: DiffsHandler }) {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const cliArgs = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as Callback;
    if (cliArgs[0] !== 'api') {
      cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: 'glab: unknown command\n' }));
      return;
    }
    const path = cliArgs[1] ?? '';
    if (path.includes('/diffs')) {
      const h = handlers.diffs;
      if (h === undefined) {
        cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: 'glab: unknown command\n' }));
        return;
      }
      if (typeof h === 'function') {
        const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
        cb(null, { stdout: JSON.stringify(h(page)), stderr: '' });
        return;
      }
      cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: `${h.fail}\n` }));
      return;
    }
    const h = handlers.detail;
    if (h === undefined) {
      cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: 'glab: 404 Not Found (HTTP 404)\n' }));
      return;
    }
    if (typeof h === 'string') {
      cb(null, { stdout: h, stderr: '' });
      return;
    }
    cb(Object.assign(new Error(`Command failed: glab ${cliArgs.join(' ')}`), { code: 1, stderr: `${h.fail}\n` }));
  });
}

const HEAD_SHA = '855b98091ea531902ba6557cb37be67324bd7c15';

const diffAdded = {
  old_path: 'src/new.ts',
  new_path: 'src/new.ts',
  new_file: true,
  deleted_file: false,
  renamed_file: false,
  diff: '@@ -0,0 +1,2 @@\n+line1\n+line2',
};
const diffRemoved = {
  old_path: 'src/gone.ts',
  new_path: 'src/gone.ts',
  new_file: false,
  deleted_file: true,
  renamed_file: false,
  diff: '@@ -1,2 +0,0 @@\n-line1\n-line2',
};
const diffRenamed = {
  old_path: 'src/old-name.ts',
  new_path: 'src/new-name.ts',
  new_file: false,
  deleted_file: false,
  renamed_file: true,
  diff: '@@ -1 +1 @@\n-old\n+new',
};
const diffModified = {
  old_path: 'src/mod.ts',
  new_path: 'src/mod.ts',
  new_file: false,
  deleted_file: false,
  renamed_file: false,
  // Hunks only, as the real `.../diffs` payload carries them: the paths live in the row's own
  // fields, and no `---`/`+++` file header opens the text.
  diff: '@@ -1,2 +1,3 @@\n-old1\n-old2\n+new1\n+new2\n+new3',
};
/** A front-matter fence deleted and a fence-like line added: content whose first characters are
 *  the ones a unified-diff header would use. */
const diffFences = {
  old_path: 'docs/page.md',
  new_path: 'docs/page.md',
  new_file: false,
  deleted_file: false,
  renamed_file: false,
  // Deletes `---`, `title: Page`, `---` and adds `+++ header-ish`, `title: Page`, `~~~`.
  diff: '@@ -1,3 +1,3 @@\n----\n-title: Page\n----\n++++ header-ish\n+title: Page\n+~~~',
};

describe('GitLab driver — prDiff', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps added/removed/renamed/modified files, counting every +/- line', async () => {
    routeGlabPrDiff({
      detail: mrDetailSha(HEAD_SHA),
      diffs: (page) => (page === 1 ? [diffAdded, diffRemoved, diffRenamed, diffModified] : []),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.prDiff!(3950);
    expect(data.available).toBe(true);
    if (!data.available) throw new Error('expected available');
    expect(data.headSha).toBe(HEAD_SHA);
    expect(data.files).toEqual([
      { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0, patch: diffAdded.diff },
      { path: 'src/gone.ts', status: 'removed', additions: 0, deletions: 2, patch: diffRemoved.diff },
      { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', additions: 1, deletions: 1, patch: diffRenamed.diff },
      { path: 'src/mod.ts', status: 'modified', additions: 3, deletions: 2, patch: diffModified.diff },
    ]);
    expect(data.additions).toBe(2 + 0 + 1 + 3);
    expect(data.deletions).toBe(0 + 2 + 1 + 2);
    expect(data.truncated).toBe(false);
  });

  // The `.../diffs` payload carries hunks, not unified-diff headers, so a `+++`/`---` prefix is
  // content: skipping it under-reported a diff that touches a YAML front-matter fence.
  it('counts content lines that begin with --- or +++', async () => {
    routeGlabPrDiff({
      detail: mrDetailSha(HEAD_SHA),
      diffs: (page) => (page === 1 ? [diffFences] : []),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.prDiff!(3950);
    expect(data.available).toBe(true);
    if (!data.available) throw new Error('expected available');
    expect(data.files).toEqual([
      { path: 'docs/page.md', status: 'modified', additions: 3, deletions: 3, patch: diffFences.diff },
    ]);
    expect(data.additions).toBe(3);
    expect(data.deletions).toBe(3);
  });

  it('drops a patch over FORGE_PR_PATCH_CAP with patchUnavailableReason too-large, truncated', async () => {
    const bigDiff = `+${'x'.repeat(FORGE_PR_PATCH_CAP + 10)}`;
    routeGlabPrDiff({
      detail: mrDetailSha(HEAD_SHA),
      diffs: (page) => (page === 1 ? [{ ...diffModified, diff: bigDiff }] : []),
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.prDiff!(3950);
    expect(data.available).toBe(true);
    if (!data.available) throw new Error('expected available');
    expect(data.files).toEqual([
      { path: 'src/mod.ts', status: 'modified', additions: 1, deletions: 0, patchUnavailableReason: 'too-large', truncated: true },
    ]);
    expect(data.truncated).toBe(true);
    expect(data.reason).toContain('One or more patches exceeded the per-file limit.');
  });

  it('an empty diff with too_large reports binary (no line changes) or not-provided (some)', async () => {
    routeGlabPrDiff({
      detail: mrDetailSha(HEAD_SHA),
      diffs: (page) =>
        page === 1
          ? [
              { ...diffModified, new_path: 'assets/logo.png', old_path: 'assets/logo.png', diff: '', too_large: true },
              { ...diffAdded, new_path: 'huge.sql', old_path: 'huge.sql', diff: '', too_large: true },
            ]
          : [],
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.prDiff!(3950);
    expect(data.available).toBe(true);
    if (!data.available) throw new Error('expected available');
    expect(data.files[0]).toMatchObject({ path: 'assets/logo.png', patchUnavailableReason: 'binary' });
    // `huge.sql` is `new_file`, but its diff came back empty (too_large) with no +/- lines counted
    // either — additions/deletions are both 0, so it lands on `binary` too, exactly like GitHub's
    // own additions===0&&deletions===0 rule for a patch-less row.
    expect(data.files[1]).toMatchObject({ path: 'huge.sql', patchUnavailableReason: 'binary' });
  });

  it('a diff set past FORGE_PR_DIFF_FILE_CAP truncates the file list and says so', async () => {
    const rows = Array.from({ length: FORGE_PR_DIFF_FILE_CAP + 5 }, (_, i) => ({
      old_path: `src/file-${i}.ts`,
      new_path: `src/file-${i}.ts`,
      new_file: false,
      deleted_file: false,
      renamed_file: false,
      diff: '@@ -1 +1 @@\n-old\n+new',
    }));
    routeGlabPrDiff({ detail: mrDetailSha(HEAD_SHA), diffs: (page) => rows.slice((page - 1) * 100, page * 100) });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.prDiff!(3950);
    expect(data.available).toBe(true);
    if (!data.available) throw new Error('expected available');
    expect(data.files).toHaveLength(FORGE_PR_DIFF_FILE_CAP);
    expect(data.truncated).toBe(true);
    expect(data.reason).toContain(`Only the first ${FORGE_PR_DIFF_FILE_CAP} files are shown.`);
  });

  it('a missing merge request (404 on the detail call) throws GithubPrNotFoundError', async () => {
    routeGlabPrDiff({}); // no detail handler → 404
    const driver = createGitlabDriver(freshRoot(), parsed());
    await expect(driver.prDiff!(999)).rejects.toBeInstanceOf(GithubPrNotFoundError);
    await expect(driver.prDiff!(999)).rejects.toThrow('Merge request #999 was not found');
  });

  it('a glab CLI failure on the detail call degrades to unavailable, not a throw', async () => {
    routeGlabPrDiff({ detail: { fail: GLAB_401 } });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.prDiff!(3950)).toEqual({ available: false, reason: GLAB_401 });
  });

  it('glab not installed (ENOENT) answers the install hint', async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as Callback;
      cb(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }));
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.prDiff!(3950)).toEqual({ available: false, reason: GLAB_NOT_FOUND_REASON });
  });

  it('caches the diff per root/number/headSha; refresh bypasses it', async () => {
    routeGlabPrDiff({ detail: mrDetailSha(HEAD_SHA), diffs: (page) => (page === 1 ? [diffAdded] : []) });
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    const first = await driver.prDiff!(3950);
    expect(first.available).toBe(true);

    routeGlabPrDiff({ detail: mrDetailSha(HEAD_SHA), diffs: (page) => (page === 1 ? [diffRemoved] : []) }); // "server" changed
    expect(await driver.prDiff!(3950)).toEqual(first); // served from cache

    const refreshed = await driver.prDiff!(3950, { refresh: true });
    if (refreshed.available) expect(refreshed.files[0]?.path).toBe('src/gone.ts');
  });

  it('is available under CEZ_DRY_RUN=1 with a demo diff, without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.prDiff!(1);
    expect(data.available).toBe(true);
    if (data.available) expect(data.files.some((f) => f.status === 'renamed')).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('evictForgeProjectCaches drops the cached diff for that root only', async () => {
    routeGlabPrDiff({ detail: mrDetailSha(HEAD_SHA), diffs: (page) => (page === 1 ? [diffAdded] : []) });
    const root = freshRoot();
    const driver = createGitlabDriver(root, parsed());
    await driver.prDiff!(3950);
    evictForgeProjectCaches(root);
    routeGlabPrDiff({ detail: mrDetailSha(HEAD_SHA), diffs: (page) => (page === 1 ? [diffRemoved] : []) });
    const data = await driver.prDiff!(3950);
    if (data.available) expect(data.files[0]?.path).toBe('src/gone.ts');
  });
});

// ---- searchItems (Step 3.6) --------------------------------------------------------------------
// `glab issue/mr list --search <q> --all --output json --per-page N` — the query is its OWN argv
// element, never interpolated into a shell string. Reuses the same fixtures/row schemas as the
// list tier (Step 3.2).

describe('GitLab driver — searchItems', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps fixture issue hits to the exact ForgeItem[], passing the query as its own argv element', async () => {
    routeGlab({ issue: ISSUES_JSON, api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.searchItems!('issue', 'publish', {});
    expect(data).toEqual({ available: true, items: ISSUES_ITEMS, truncated: false, labelColors: { 'type::bug': 'd73a4a', 'type::maintenance': '6699cc' } });
    const call = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'issue');
    expect(call?.[1]).toEqual(['issue', 'list', '--search', 'publish', '--all', '--output', 'json', '--per-page', String(GH_SEARCH_MAX)]);
  });

  it('maps fixture MR hits to the exact ForgeItem[]', async () => {
    routeGlab({ mr: MRS_JSON, api: LABELS_JSON });
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.searchItems!('pr', 'delegate', {});
    expect(data.available).toBe(true);
    expect(data.items).toEqual(MRS_ITEMS);
    const call = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'mr');
    expect(call?.[1]).toEqual(['mr', 'list', '--search', 'delegate', '--all', '--output', 'json', '--per-page', String(GH_SEARCH_MAX)]);
  });

  it('an empty hit list answers available with no items', async () => {
    routeGlab({ issue: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.searchItems!('issue', 'nothing-matches-this', {})).toEqual({
      available: true,
      items: [],
      truncated: false,
      labelColors: {},
    });
  });

  it('a blank query answers available with no items, without shelling out', async () => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.searchItems!('issue', '   ', {})).toEqual({ available: true, items: [] });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('flags truncated when the hit count reaches the requested limit', async () => {
    // The fixture answers the same 3-row MRS_JSON regardless of `--per-page`, so a `limit` at or
    // below the hit count exercises the cap-reached branch and a higher one does not.
    routeGlab({ mr: MRS_JSON, api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());

    const capped = await driver.searchItems!('pr', 'x', { limit: 2 });
    expect(capped.truncated).toBe(true);
    const call = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'mr');
    expect(call?.[1]).toEqual(['mr', 'list', '--search', 'x', '--all', '--output', 'json', '--per-page', '2']);

    execFileMock.mockReset();
    routeGlab({ mr: MRS_JSON, api: '[]' });
    const uncapped = await driver.searchItems!('pr', 'x', { limit: 10 });
    expect(uncapped.truncated).toBe(false);
  });

  it('a limit above GH_SEARCH_MAX is clamped to it', async () => {
    routeGlab({ issue: '[]', api: '[]' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    await driver.searchItems!('issue', 'x', { limit: 5_000 });
    const call = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'issue');
    expect(call?.[1]).toEqual(['issue', 'list', '--search', 'x', '--all', '--output', 'json', '--per-page', String(GH_SEARCH_MAX)]);
  });

  it('a malformed hit list answers unavailable with a clear reason', async () => {
    routeGlab({ issue: 'not json' });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.searchItems!('issue', 'x', {})).toEqual({
      available: false,
      reason: 'glab issue list returned an unexpected response',
      items: [],
    });
  });

  it('a glab CLI failure answers unavailable with its own first stderr line', async () => {
    routeGlab({ mr: { fail: GLAB_401 } });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.searchItems!('pr', 'x', {})).toEqual({ available: false, reason: GLAB_401, items: [] });
  });

  it('glab not installed (ENOENT) answers the install hint', async () => {
    execFileMock.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as Callback;
      cb(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }));
    });
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(await driver.searchItems!('issue', 'x', {})).toEqual({ available: false, reason: GLAB_NOT_FOUND_REASON, items: [] });
  });

  it('a labels endpoint failure leaves the hits available without labelColors', async () => {
    routeGlab({ issue: ISSUES_JSON }); // no `api` handler — labels call fails
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.searchItems!('issue', 'x', {});
    expect(data.available).toBe(true);
    expect(data.items).toEqual(ISSUES_ITEMS);
    expect(data.labelColors).toBeUndefined();
  });

  it('is available under CEZ_DRY_RUN=1 with a filtered demo catalog, without shelling out', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGitlabDriver(freshRoot(), parsed());
    const data = await driver.searchItems!('pr', '1', {});
    expect(data.available).toBe(true);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.number).toBe(1);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ---- viewUrl (Step 3.7) --------------------------------------------------------------------------
// Base is the cached `web_url` from a successful `detect()` probe (exact even on a non-root
// instance — Minor 5, spec 2026-08-10-forge-provider-adapters), falling back to `origin + path`
// (Step 2.3) when nothing has been probed yet. `/-/` is GitLab's own path grammar. Branch names
// with slashes are encoded per segment, mirroring the GitHub driver's viewUrl.

describe('GitLab driver — viewUrl', () => {
  beforeEach(() => {
    vi.stubEnv('CEZ_DRY_RUN', '');
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['repo', 'x', 'https://gitlab.com/acme/demo'],
    ['issue', 8564, 'https://gitlab.com/acme/demo/-/issues/8564'],
    ['pr', 3950, 'https://gitlab.com/acme/demo/-/merge_requests/3950'],
    ['branch', 'feat/a b', 'https://gitlab.com/acme/demo/-/tree/feat/a%20b'],
    ['commit', 'abc1234', 'https://gitlab.com/acme/demo/-/commit/abc1234'],
  ] as const)('%s → %s (from origin + path, before any probe)', (kind, ref, expected) => {
    const driver = createGitlabDriver(freshRoot(), parsed());
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });

  it('prefers the cached web_url once a probe has run — exact on a non-root instance', async () => {
    glabOk(JSON.stringify({ web_url: 'https://intranet/gitlab/group/repo', path_with_namespace: 'group/repo' }));
    const root = freshRoot();
    const remote = parseRemote('https://intranet/gitlab/group/repo.git');
    if (!remote) throw new Error('fixture remote must parse');
    const driver = createGitlabDriver(root, remote);
    await driver.detect();
    expect(driver.viewUrl('issue', 1)).toBe('https://intranet/gitlab/group/repo/-/issues/1');
  });

  it('falls back to origin + path on a non-root instance before any probe', () => {
    const remote = parseRemote('https://intranet/gitlab/group/repo.git');
    if (!remote) throw new Error('fixture remote must parse');
    const driver = createGitlabDriver(freshRoot(), remote);
    expect(driver.viewUrl('pr', 7)).toBe('https://intranet/gitlab/group/repo/-/merge_requests/7');
  });

  it('answers null when neither the cache nor a parsed origin/path is known', () => {
    const driver = createGitlabDriver(freshRoot(), { host: 'x', owner: 'x', repo: 'x', path: '', origin: '' });
    expect(driver.viewUrl('repo', 'x')).toBeNull();
  });
});
