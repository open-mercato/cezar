import { afterEach, describe, expect, it, vi } from 'vitest';

// scripts/lib/github.mts is the release-line workflows' only GitHub writer; its "re-runs are
// safe" promises (docs/publishing.md § Release lines) are pinned here against a stubbed fetch.

interface Client {
  setBranch(branch: string, sha: string): Promise<void>;
  commitFiles(input: { parentSha: string; files: { path: string; content: string }[]; message: string }): Promise<string>;
  openPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<{ html_url: string }>;
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  addLabels(number: number, labels: string[]): Promise<void>;
  createRelease(input: { tag: string; sha: string; name: string; body: string; makeLatest: boolean }): Promise<boolean>;
  getTagSha(tag: string): Promise<string | null>;
  createTag(tag: string, sha: string): Promise<boolean>;
  releasedTags(): Promise<string[]>;
  readFile(path: string, ref: string): Promise<string>;
}

const modulePath = new URL('../../../../scripts/lib/github.mts', import.meta.url).href;
const { githubClient } = (await import(modulePath)) as {
  githubClient: (opts: { token: string | undefined; repository: string | undefined }) => Client;
};

type Reply = { status: number; data?: unknown };
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Answers each request with the first route whose `METHOD path-prefix` key matches. */
function stubGitHub(routes: Record<string, Reply>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(routes).find((k) => {
      const [method, prefix] = k.split(' ');
      return method === init.method && path.startsWith(prefix!);
    });
    const reply = key ? routes[key]! : { status: 404, data: { message: 'Not Found' } };
    return new Response(reply.data === undefined ? '' : JSON.stringify(reply.data), { status: reply.status });
  });
  return calls;
}

const client = () => githubClient({ token: 't', repository: 'acme/app' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('githubClient', () => {
  it('refuses to start without a token or with a malformed repository', () => {
    expect(() => githubClient({ token: '', repository: 'acme/app' })).toThrow(/GH_TOKEN/);
    expect(() => githubClient({ token: 't', repository: 'acme' })).toThrow(/GITHUB_REPOSITORY/);
  });

  it('creates a missing branch and force-moves an existing one', async () => {
    let calls = stubGitHub({ 'POST /repos/acme/app/git/refs': { status: 201, data: {} } });
    await client().setBranch('chore/open-v0.17.0', 'abc');
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/repos/acme/app/git/refs',
      body: { ref: 'refs/heads/chore/open-v0.17.0', sha: 'abc' },
    });

    calls = stubGitHub({
      'GET /repos/acme/app/git/ref/heads/chore/open-v0.17.0': { status: 200, data: { object: { sha: 'old' } } },
      'PATCH /repos/acme/app/git/refs/heads/chore/open-v0.17.0': { status: 200, data: {} },
    });
    await client().setBranch('chore/open-v0.17.0', 'abc');
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { sha: 'abc', force: true } });
  });

  it('commits files as one commit on top of the parent', async () => {
    const calls = stubGitHub({
      'GET /repos/acme/app/git/commits/parent': { status: 200, data: { tree: { sha: 'base-tree' } } },
      'POST /repos/acme/app/git/trees': { status: 201, data: { sha: 'tree' } },
      'POST /repos/acme/app/git/commits': { status: 201, data: { sha: 'new' } },
    });
    const sha = await client().commitFiles({
      parentSha: 'parent',
      files: [{ path: 'CHANGELOG.md', content: '# 1.0.0\n' }],
      message: 'chore(release): 1.0.0',
    });
    expect(sha).toBe('new');
    expect(calls[1]!.body).toEqual({
      base_tree: 'base-tree',
      tree: [{ path: 'CHANGELOG.md', mode: '100644', type: 'blob', content: '# 1.0.0\n' }],
    });
    expect(calls[2]!.body).toEqual({ message: 'chore(release): 1.0.0', tree: 'tree', parents: ['parent'] });
  });

  it('reuses an open PR for the same head and base instead of opening another', async () => {
    const calls = stubGitHub({
      'GET /repos/acme/app/pulls': { status: 200, data: [{ html_url: 'https://github.com/acme/app/pull/7' }] },
    });
    const pr = await client().openPullRequest({ head: 'chore/x', base: 'main', title: 't', body: 'b' });
    expect(pr.html_url).toBe('https://github.com/acme/app/pull/7');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(calls[0]!.path).toContain('head=acme:chore%2Fx');
  });

  it('opens a PR when none is open', async () => {
    const calls = stubGitHub({
      'GET /repos/acme/app/pulls': { status: 200, data: [] },
      'POST /repos/acme/app/pulls': { status: 201, data: { html_url: 'https://github.com/acme/app/pull/8' } },
    });
    const pr = await client().openPullRequest({ head: 'chore/x', base: 'main', title: 't', body: 'b' });
    expect(pr.html_url).toBe('https://github.com/acme/app/pull/8');
    expect(calls.at(-1)!.body).toEqual({ head: 'chore/x', base: 'main', title: 't', body: 'b' });
  });

  it('treats an existing label as success and any other failure as an error', async () => {
    stubGitHub({ 'POST /repos/acme/app/labels': { status: 422, data: { message: 'already_exists' } } });
    await expect(client().ensureLabel('backport main', 'c5def5', 'd')).resolves.toBeUndefined();
    stubGitHub({ 'POST /repos/acme/app/labels': { status: 403, data: { message: 'Forbidden' } } });
    await expect(client().ensureLabel('backport main', 'c5def5', 'd')).rejects.toThrow(/403/);
  });

  it('adds labels to a PR through the issues API', async () => {
    const calls = stubGitHub({ 'POST /repos/acme/app/issues/7/labels': { status: 200, data: [] } });
    await client().addLabels(7, ['skip-changelog']);
    expect(calls).toEqual([{ method: 'POST', path: '/repos/acme/app/issues/7/labels', body: { labels: ['skip-changelog'] } }]);
  });

  it('leaves an existing release alone and creates a missing one at the given commit', async () => {
    let calls = stubGitHub({ 'GET /repos/acme/app/releases/tags/v1.0.0': { status: 200, data: {} } });
    const release = { tag: 'v1.0.0', sha: 'abc', name: 'v1.0.0', body: 'notes', makeLatest: false };
    expect(await client().createRelease(release)).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET']);

    calls = stubGitHub({ 'POST /repos/acme/app/releases': { status: 201, data: {} } });
    expect(await client().createRelease(release)).toBe(true);
    expect(calls.at(-1)!.body).toMatchObject({ tag_name: 'v1.0.0', target_commitish: 'abc', make_latest: 'false' });
  });

  it('dereferences an annotated tag to its commit', async () => {
    stubGitHub({
      'GET /repos/acme/app/git/ref/tags/v1.0.0': { status: 200, data: { object: { type: 'tag', sha: 'tagobj' } } },
      'GET /repos/acme/app/git/tags/tagobj': { status: 200, data: { object: { sha: 'commit1' } } },
    });
    expect(await client().getTagSha('v1.0.0')).toBe('commit1');
    expect(await client().getTagSha('v9.9.9')).toBeNull();
  });

  it('creates a missing tag, keeps one already at the commit, and refuses to move one', async () => {
    const calls = stubGitHub({
      'GET /repos/acme/app/git/ref/tags/v1.0.1': { status: 200, data: { object: { type: 'commit', sha: 'same' } } },
      'POST /repos/acme/app/git/refs': { status: 201, data: {} },
    });
    expect(await client().createTag('v1.0.2', 'new')).toBe(true);
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/repos/acme/app/git/refs', body: { ref: 'refs/tags/v1.0.2', sha: 'new' } });
    expect(await client().createTag('v1.0.1', 'same')).toBe(false);
    await expect(client().createTag('v1.0.1', 'other')).rejects.toThrow(/already points at same/);
  });

  it('lists released tags across pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}` }));
    stubGitHub({
      'GET /repos/acme/app/releases?per_page=100&page=1': { status: 200, data: page1 },
      'GET /repos/acme/app/releases?per_page=100&page=2': { status: 200, data: [{ tag_name: 'v1.0.0' }, { tag_name: 'v1.0.1', draft: true }] },
    });
    const tags = await client().releasedTags();
    expect(tags).toHaveLength(101);
    expect(tags.at(-1)).toBe('v1.0.0');
    // A draft is not "done": hasRelease() cannot see it either.
    expect(tags).not.toContain('v1.0.1');
  });

  it('reads a file over 1 MB through the blob API', async () => {
    stubGitHub({
      'GET /repos/acme/app/contents/CHANGELOG.md': { status: 200, data: { sha: 'b1', content: '' } },
      'GET /repos/acme/app/git/blobs/b1': { status: 200, data: { content: Buffer.from('# big').toString('base64') } },
    });
    expect(await client().readFile('CHANGELOG.md', 'main')).toBe('# big');
  });

  it('surfaces a failed write with its method, path and message', async () => {
    stubGitHub({ 'GET /repos/acme/app/git/commits/parent': { status: 404, data: { message: 'No commit found' } } });
    await expect(
      client().commitFiles({ parentSha: 'parent', files: [], message: 'm' }),
    ).rejects.toThrow('GET /repos/acme/app/git/commits/parent → 404: No commit found');
  });
});
