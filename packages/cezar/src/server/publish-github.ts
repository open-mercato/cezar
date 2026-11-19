import { GITHUB_REPO_NAME_PATTERN } from '@open-mercato/cezar-contract';
import { GH_CREDENTIAL_HELPER_CONFIG } from './checkout.ts';
import { dryRunCommandRunner, listGithubOwners, spawnCommandRunner, type CommandResult, type CommandRunner } from './create-project.ts';
import { getRepoInfo } from './git.ts';

/**
 * `POST /api/v1/projects/:projectId/publish-github` (spec 2026-10-26-first-run-onboarding): a local
 * repository with no remote becomes a new PRIVATE GitHub repository. The remote is the HTTPS URL
 * and the `gh` credential helper is persisted, exactly as `projects/create` does (#968), so a task
 * worktree's later raw `git push` authenticates the same way. cezar never deletes the GitHub
 * repository if a later step fails; the error says it exists.
 */

const OWNER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const GH_MISSING = 'gh CLI not found — install it and run `gh auth login`';

export type PublishGithubResult =
  | { ok: true; slug: string; url: string }
  | { ok: false; status: 400 | 403 | 409 | 500 | 503; error: string };

export async function publishToGithub(opts: {
  root: string;
  owner: string;
  name: string;
  run?: CommandRunner;
  signal?: AbortSignal;
}): Promise<PublishGithubResult> {
  const owner = opts.owner.trim();
  const name = opts.name.trim();
  if (owner.length > 64 || !OWNER_SEGMENT.test(owner)) {
    return { ok: false, status: 400, error: `not a valid GitHub owner: ${owner.slice(0, 200)}` };
  }
  if (!GITHUB_REPO_NAME_PATTERN.test(name)) {
    return { ok: false, status: 400, error: `not a valid repository name: ${name.slice(0, 200)}` };
  }
  const info = await getRepoInfo(opts.root);
  if (!info) return { ok: false, status: 409, error: 'not a git repository with a commit yet' };
  if (info.remote) return { ok: false, status: 409, error: `already has a remote: ${info.remote}` };

  // Only an account `gh` lists — the same list the dialog offers. GitHub would refuse another
  // owner anyway; asking first keeps a crafted request from even trying.
  const owners = await listGithubOwners(opts.run);
  if (!owners.available) return { ok: false, status: 503, error: owners.reason };
  if (!owners.owners.some((entry) => entry.login.toLowerCase() === owner.toLowerCase())) {
    return { ok: false, status: 403, error: `${owner} is not one of your GitHub accounts` };
  }

  const slug = `${owner}/${name}`;
  const run = opts.run ?? (process.env.CEZ_DRY_RUN === '1' ? dryRunCommandRunner : spawnCommandRunner);
  // Every call goes through the shared runner, which gives `gh` its `ghEnv` environment.
  const exec = async (cmd: Parameters<CommandRunner>[0], args: string[]): Promise<CommandResult> => {
    try {
      return await run(cmd, args, { cwd: info.root, signal: opts.signal });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const created = (error: string): PublishGithubResult => ({
    ok: false,
    status: 500,
    error: `${firstLine(error)}\n(the private repository ${slug} was created on GitHub)`,
  });

  const repo = await exec('gh', ['repo', 'create', slug, '--private']);
  if (!repo.ok) {
    if (repo.notFound) return { ok: false, status: 503, error: GH_MISSING };
    if (/already exists/i.test(repo.error)) {
      return { ok: false, status: 409, error: `${slug} already exists on GitHub. Pick another name.` };
    }
    return { ok: false, status: 500, error: firstLine(repo.error) };
  }
  const remoteUrl = `https://github.com/${slug}.git`;
  const remote = await exec('git', ['remote', 'add', 'origin', remoteUrl]);
  if (!remote.ok) return created(remote.error);
  for (const args of GH_CREDENTIAL_HELPER_CONFIG) {
    const helper = await exec('git', ['config', '--local', ...args]);
    if (!helper.ok) return created(`could not configure GitHub credentials: ${helper.error}`);
  }
  const pushed = await exec('git', ['push', '-u', 'origin', info.branch]);
  if (!pushed.ok) return created(pushed.error);
  return { ok: true, slug, url: `https://github.com/${slug}` };
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}
