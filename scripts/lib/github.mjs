// The few GitHub REST/GraphQL calls the release-line workflows make (scripts/release-line.mjs).
//
// Commits go through the git data API rather than `git push`: GitHub signs them, which a
// signed-commits ruleset requires, and a plain token can create them on a branch it may write.
// A PR opened with the workflow's own GITHUB_TOKEN triggers no CI, so callers pass
// RELEASE_TOKEN when it is configured (docs/publishing.md).

const API = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');

export function githubClient({ token, repository }) {
  if (!token) throw new Error('GH_TOKEN is not set');
  if (!/^[^/]+\/[^/]+$/.test(repository ?? '')) throw new Error(`bad GITHUB_REPOSITORY "${repository}"`);
  const [owner, repo] = repository.split('/');

  const call = async (method, path, body) => {
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
    const data = text ? JSON.parse(text) : null;
    return { status: res.status, data };
  };
  const ok = async (method, path, body) => {
    const { status, data } = await call(method, path, body);
    if (status >= 300) throw new Error(`${method} ${path} → ${status}: ${data?.message ?? ''}`);
    return data;
  };
  const r = `/repos/${owner}/${repo}`;

  return {
    owner,
    repo,
    async getBranchSha(branch) {
      const { status, data } = await call('GET', `${r}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`);
      return status === 200 ? data.object.sha : null;
    },
    async createBranch(branch, sha) {
      await ok('POST', `${r}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    },
    async moveBranch(branch, sha, force) {
      await ok('PATCH', `${r}/git/refs/heads/${branch}`, { sha, force });
    },
    async setBranch(branch, sha) {
      if ((await this.getBranchSha(branch)) === null) await this.createBranch(branch, sha);
      else await this.moveBranch(branch, sha, true);
    },
    /** One commit on top of `parentSha` carrying `files` ({ path, content }). Returns its sha. */
    async commitFiles({ parentSha, files, message }) {
      const parent = await ok('GET', `${r}/git/commits/${parentSha}`);
      const tree = await ok('POST', `${r}/git/trees`, {
        base_tree: parent.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      });
      const commit = await ok('POST', `${r}/git/commits`, { message, tree: tree.sha, parents: [parentSha] });
      return commit.sha;
    },
    async readFile(path, ref) {
      const data = await ok('GET', `${r}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      return Buffer.from(data.content, 'base64').toString('utf8');
    },
    /** Open a PR, or return the open one already proposing `head` → `base`. */
    async openPullRequest({ head, base, title, body }) {
      const existing = await ok('GET', `${r}/pulls?state=open&base=${encodeURIComponent(base)}&head=${owner}:${encodeURIComponent(head)}`);
      if (existing.length > 0) return existing[0];
      return ok('POST', `${r}/pulls`, { head, base, title, body });
    },
    async addLabels(number, labels) {
      await ok('POST', `${r}/issues/${number}/labels`, { labels });
    },
    async ensureLabel(name, color, description) {
      const { status } = await call('POST', `${r}/labels`, { name, color, description });
      if (status !== 201 && status !== 422) throw new Error(`creating label "${name}" → ${status}`);
    },
    async generateNotes({ tag, target, previousTag }) {
      const data = await ok('POST', `${r}/releases/generate-notes`, {
        tag_name: tag,
        target_commitish: target,
        ...(previousTag ? { previous_tag_name: previousTag } : {}),
      });
      return data.body ?? '';
    },
    /** Create the release (and its tag at `sha`); a release that already exists is left alone. */
    async createRelease({ tag, sha, name, body, makeLatest }) {
      const { status } = await call('GET', `${r}/releases/tags/${encodeURIComponent(tag)}`);
      if (status === 200) return false;
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
}
