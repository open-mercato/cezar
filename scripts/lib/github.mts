// The few GitHub REST calls the release-line workflows make (scripts/release-line.mts).
//
// Commits go through the git data API rather than `git push`, so GitHub signs them. Callers pass
// the release GitHub App's installation token: PRs and tags made with the workflow's own
// GITHUB_TOKEN trigger no workflows (docs/publishing.md § Release lines).

const API = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');

type Method = 'GET' | 'POST' | 'PATCH';
interface Reply<T> {
  status: number;
  data: T | null;
}
interface GitObject {
  object: { sha: string; type: string };
}
export interface PullRequest {
  number: number;
  html_url: string;
  node_id: string;
}
export interface CommitFile {
  path: string;
  content: string;
}

export function githubClient({ token, repository }: { token: string | undefined; repository: string | undefined }) {
  if (!token) throw new Error('GH_TOKEN is not set');
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error(`bad GITHUB_REPOSITORY "${repository}"`);
  const [owner, repo] = repository.split('/') as [string, string];

  const call = async <T,>(method: Method, path: string, body?: unknown): Promise<Reply<T>> => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  };
  const ok = async <T,>(method: Method, path: string, body?: unknown): Promise<T> => {
    const { status, data } = await call<T & { message?: string }>(method, path, body);
    if (status >= 300) throw new Error(`${method} ${path} → ${status}: ${data?.message ?? ''}`);
    return data as T;
  };
  const r = `/repos/${owner}/${repo}`;

  const client = {
    owner,
    repo,
    async getBranchSha(branch: string): Promise<string | null> {
      const { status, data } = await call<GitObject>('GET', `${r}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`);
      return status === 200 && data ? data.object.sha : null;
    },
    async createBranch(branch: string, sha: string): Promise<void> {
      await ok('POST', `${r}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    },
    async moveBranch(branch: string, sha: string, force: boolean): Promise<void> {
      await ok('PATCH', `${r}/git/refs/heads/${branch}`, { sha, force });
    },
    async setBranch(branch: string, sha: string): Promise<void> {
      if ((await client.getBranchSha(branch)) === null) await client.createBranch(branch, sha);
      else await client.moveBranch(branch, sha, true);
    },
    /** One commit on top of `parentSha` carrying `files`. Returns its sha. */
    async commitFiles({ parentSha, files, message }: { parentSha: string; files: CommitFile[]; message: string }): Promise<string> {
      const parent = await ok<{ tree: { sha: string } }>('GET', `${r}/git/commits/${parentSha}`);
      const tree = await ok<{ sha: string }>('POST', `${r}/git/trees`, {
        base_tree: parent.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      });
      const commit = await ok<{ sha: string }>('POST', `${r}/git/commits`, { message, tree: tree.sha, parents: [parentSha] });
      return commit.sha;
    },
    async readFile(path: string, ref: string): Promise<string> {
      const data = await ok<{ sha: string; content?: string }>('GET', `${r}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      // Over 1 MB the contents API omits `content`; the blob API still serves it.
      const content = data.content || (await ok<{ content: string }>('GET', `${r}/git/blobs/${data.sha}`)).content;
      return Buffer.from(content, 'base64').toString('utf8');
    },
    /** The commit a tag points at, or `null` when there is no such tag. */
    async getTagSha(tag: string): Promise<string | null> {
      const { status, data } = await call<GitObject>('GET', `${r}/git/ref/tags/${encodeURIComponent(tag)}`);
      if (status !== 200 || !data) return null;
      if (data.object.type !== 'tag') return data.object.sha;
      return (await ok<GitObject>('GET', `${r}/git/tags/${data.object.sha}`)).object.sha;
    },
    /** Tag `sha`; an existing tag is fine only when it already points there. */
    async createTag(tag: string, sha: string): Promise<boolean> {
      const existing = await client.getTagSha(tag);
      if (existing === sha) return false;
      if (existing) throw new Error(`tag ${tag} already points at ${existing}, not ${sha}`);
      await ok('POST', `${r}/git/refs`, { ref: `refs/tags/${tag}`, sha });
      return true;
    },
    /** Tag names that have a published GitHub Release. Drafts don't count — the same definition
     *  as `hasRelease`, whose by-tag lookup never returns a draft. */
    async releasedTags(): Promise<string[]> {
      const tags: string[] = [];
      for (let page = 1; page <= 20; page += 1) {
        const batch = await ok<{ tag_name: string; draft?: boolean }[]>('GET', `${r}/releases?per_page=100&page=${page}`);
        tags.push(...batch.filter((rel) => rel.draft !== true).map((rel) => rel.tag_name));
        if (batch.length < 100) break;
      }
      return tags;
    },
    async hasRelease(tag: string): Promise<boolean> {
      const { status } = await call('GET', `${r}/releases/tags/${encodeURIComponent(tag)}`);
      return status === 200;
    },
    /** PRs merged within the last `days`, newest activity first (at most 300 scanned). */
    async mergedPulls(days: number): Promise<{ number: number; base: string; labels: string[] }[]> {
      const since = Date.now() - days * 86_400_000;
      const out: { number: number; base: string; labels: string[] }[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const batch = await ok<{ number: number; merged_at: string | null; updated_at: string; base: { ref: string }; labels: { name: string }[] }[]>(
          'GET',
          `${r}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
        );
        for (const pr of batch) {
          if (pr.merged_at && Date.parse(pr.merged_at) >= since) {
            out.push({ number: pr.number, base: pr.base.ref, labels: pr.labels.map((l) => l.name) });
          }
        }
        // Sorted by update time: once a page ends before the window, nothing older can be in it.
        const last = batch.at(-1);
        if (batch.length < 100 || (last && Date.parse(last.updated_at) < since)) break;
      }
      return out;
    },
    /** The state of the PR whose head is `branch` in this repository, if any: an open one wins,
     *  then a merged one, then a closed one. */
    async pullStateByHead(branch: string): Promise<'open' | 'merged' | 'closed' | null> {
      const pulls = await ok<{ state: string; merged_at: string | null }[]>(
        'GET',
        `${r}/pulls?state=all&head=${owner}:${encodeURIComponent(branch)}&per_page=100`,
      );
      if (pulls.some((p) => p.state === 'open')) return 'open';
      if (pulls.some((p) => p.merged_at)) return 'merged';
      return pulls.length > 0 ? 'closed' : null;
    },
    /** Open a PR, or return the open one already proposing `head` → `base`. */
    async openPullRequest({ head, base, title, body }: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
      const existing = await ok<PullRequest[]>('GET', `${r}/pulls?state=open&base=${encodeURIComponent(base)}&head=${owner}:${encodeURIComponent(head)}`);
      if (existing[0]) return existing[0];
      return ok<PullRequest>('POST', `${r}/pulls`, { head, base, title, body });
    },
    async addLabels(number: number, labels: readonly string[]): Promise<void> {
      await ok('POST', `${r}/issues/${number}/labels`, { labels });
    },
    async ensureLabel(name: string, color: string, description: string): Promise<void> {
      const { status } = await call('POST', `${r}/labels`, { name, color, description });
      if (status !== 201 && status !== 422) throw new Error(`creating label "${name}" → ${status}`);
    },
    async generateNotes({ tag, target, previousTag }: { tag: string; target: string; previousTag: string | null }): Promise<string> {
      const data = await ok<{ body?: string }>('POST', `${r}/releases/generate-notes`, {
        tag_name: tag,
        target_commitish: target,
        ...(previousTag ? { previous_tag_name: previousTag } : {}),
      });
      return data.body ?? '';
    },
    /** Create the release at `sha`; a release that already exists is left alone. */
    async createRelease({ tag, sha, name, body, makeLatest }: { tag: string; sha: string; name: string; body: string; makeLatest: boolean }): Promise<boolean> {
      if (await client.hasRelease(tag)) return false;
      await ok('POST', `${r}/releases`, {
        tag_name: tag,
        target_commitish: sha,
        name,
        body,
        draft: false,
        prerelease: false,
        make_latest: makeLatest ? 'true' : 'false',
      });
      return true;
    },
  };
  return client;
}

export type GitHubClient = ReturnType<typeof githubClient>;
