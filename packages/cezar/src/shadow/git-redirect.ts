import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Where a shadow run's `git push` goes (spec `2026-10-06-shadow-runs` § The push boundary).
 *
 * Not a hook in the user's repository and not a wrapper around `git`: the redirect is git's OWN
 * URL rewriting, injected through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` into
 * the environment of the agent and of every process it starts. Environment config outranks every
 * config file, so it holds for any git process in the run's tree - the agent's own tool calls, a
 * test script, a check step - without touching `.git/config` and without a daemon.
 *
 * Three rules, longest match first (git's own `insteadOf` precedence):
 *  1. every URL a configured remote pushes to is rewritten to that remote's SHADOW repository, a
 *     local bare repo whose `pre-receive` hook records the ref update as an intent and rejects it;
 *  2. every other network push (`https://`, `ssh://`, `git@`...) is rewritten into a directory
 *     that does not exist, so it fails instead of leaving the machine;
 *  3. a remote with an explicit `pushurl` is rewritten through `insteadOf` on that exact URL,
 *     because git ignores `pushInsteadOf` for such a remote.
 *
 * And one guarantee: `verifyPushRedirect` asks git itself, with the final environment, where each
 * remote now pushes. Anything but the shadow target refuses the run (git older than 2.31 ignores
 * `GIT_CONFIG_COUNT` entirely, and this is where that is caught). A shadow run never starts
 * unshadowed.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git, never throw - the caller decides what a failure means. */
export type Git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<GitResult>;

export const defaultGit: Git = (cwd, args, env) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: env ?? process.env, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', timeout: 30_000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });

export interface GitRemoteUrls {
  name: string;
  /** `remote.<name>.url` values - fetch URLs, and the push URLs when no `pushurl` is set. */
  urls: string[];
  /** `remote.<name>.pushurl` values. */
  pushUrls: string[];
}

/** Parse `git config -z --get-regexp '^remote\..*\.(url|pushurl)$'`: NUL-separated entries of
 *  `key\nvalue`, so a remote name with a space survives. Remote names may also contain dots, so
 *  the name is everything between `remote.` and the LAST dot. */
export function parseRemoteConfig(output: string): GitRemoteUrls[] {
  const byName = new Map<string, GitRemoteUrls>();
  for (const entry of output.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline <= 0) continue;
    const key = entry.slice(0, newline);
    const value = entry.slice(newline + 1).trim();
    if (!key.startsWith('remote.') || value === '') continue;
    const dot = key.lastIndexOf('.');
    const name = key.slice('remote.'.length, dot);
    const field = key.slice(dot + 1).toLowerCase();
    if (!name || (field !== 'url' && field !== 'pushurl')) continue;
    const remote = byName.get(name) ?? { name, urls: [], pushUrls: [] };
    (field === 'url' ? remote.urls : remote.pushUrls).push(value);
    byName.set(name, remote);
  }
  return [...byName.values()];
}

export async function readRemotes(repoRoot: string, git: Git = defaultGit): Promise<GitRemoteUrls[]> {
  // Exit 1 with no output is "no remote configured", which is a valid answer, not an error.
  const result = await git(repoRoot, ['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
  return parseRemoteConfig(result.stdout);
}

export interface ConfigEntry {
  key: string;
  value: string;
}

export interface RedirectPlan {
  entries: ConfigEntry[];
  /** Remote name -> the local path its pushes land in, as git will print it. */
  targets: Record<string, string>;
  /** Prefix every other network push is rewritten under. Never exists on disk. */
  blockedBase: string;
}

export type PlanResult = { ok: true; plan: RedirectPlan } | { ok: false; reason: string };

/** Every push that is not to a configured remote. `git@` covers scp-like URLs for the user every
 *  forge uses; other scp users are added per remote below. */
const CATCH_ALL_PREFIXES = ['https://', 'http://', 'ssh://', 'git+ssh://', 'ssh+git://', 'git://', 'ftp://', 'ftps://', 'git@'];

/** The scp-like prefixes of a remote URL (`deploy@git.example.com:team/repo.git`,
 *  `github.com:o/r`): `user@host:` when there is a user, and `host:` either way, so a push to the
 *  same host spelled without the user is blocked too. A scheme URL or a local path yields none. */
function scpPrefixes(url: string): string[] {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[a-z]:[\\/]/i.test(url)) return [];
  const match = /^(?:([^@/:\s]+)@)?([^@:/\s]{2,}):/.exec(url);
  if (!match) return [];
  const [, user, host] = match;
  return user ? [`${user}@${host}:`, `${host}:`] : [`${host}:`];
}

/** Git spells a local path with forward slashes on every platform; so must the rewrite targets,
 *  or `remote get-url` would print a path that never compares equal to the one planned. */
export function gitPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** A directory name for a remote: readable, and unique even when two names sanitize alike. */
export function remoteSlug(name: string): string {
  const readable = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'remote';
  return `${readable}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
}

export function planPushRedirect(
  remotes: readonly GitRemoteUrls[],
  dirs: { remoteTarget: (name: string) => string; blockedBase: string },
): PlanResult {
  const entries: ConfigEntry[] = [];
  const targets: Record<string, string> = {};
  const allFetchUrls = remotes.flatMap((remote) => remote.urls);

  for (const remote of remotes) {
    const target = gitPath(dirs.remoteTarget(remote.name));
    targets[remote.name] = target;
    if (remote.pushUrls.length > 0) {
      for (const pushUrl of remote.pushUrls) {
        // `insteadOf` rewrites fetches too. That is harmless only while no fetch URL starts with
        // this push URL; otherwise the agent's `git fetch` would read an empty shadow repository.
        if (allFetchUrls.some((url) => url.startsWith(pushUrl))) {
          return {
            ok: false,
            reason: `remote "${remote.name}" pushes to ${pushUrl}, which is also how it fetches - shadow mode cannot redirect its pushes without breaking its fetches`,
          };
        }
        entries.push({ key: `url.${target}.insteadOf`, value: pushUrl });
      }
      continue;
    }
    for (const url of remote.urls) {
      entries.push({ key: `url.${target}.pushInsteadOf`, value: url });
      // The same repository spelled with or without `.git` is still that repository.
      const twin = url.endsWith('.git') ? url.slice(0, -'.git'.length) : `${url}.git`;
      if (twin.length > 0) entries.push({ key: `url.${target}.pushInsteadOf`, value: twin });
    }
  }

  const blockedBase = gitPath(dirs.blockedBase);
  const prefixes = new Set(CATCH_ALL_PREFIXES);
  for (const url of remotes.flatMap((remote) => [...remote.urls, ...remote.pushUrls])) {
    for (const prefix of scpPrefixes(url)) prefixes.add(prefix);
  }
  for (const prefix of prefixes) entries.push({ key: `url.${blockedBase}/.pushInsteadOf`, value: prefix });

  return { ok: true, plan: { entries, targets, blockedBase } };
}

/**
 * The environment that carries the plan. Cezar owns `GIT_CONFIG_COUNT` inside a shadow run: a
 * host value is superseded rather than extended, because extending it would require the host's
 * `GIT_CONFIG_KEY_n` to reach the child, and the curated agent environment drops them (#427).
 */
export function gitConfigEnv(entries: readonly ConfigEntry[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach((entry, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = entry.key;
    env[`GIT_CONFIG_VALUE_${index}`] = entry.value;
  });
  return env;
}

/** `.invalid` never resolves (RFC 2606), so even a probe git failed to rewrite cannot reach anything. */
const PROBE_HOST = 'shadow-probe.invalid';
const PROBE_URL = `https://${PROBE_HOST}/cezar/probe.git`;

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const left = gitPath(a);
  const right = gitPath(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Ask git, with the redirect entries the agent will get, where every remote pushes now - and
 * where a push to a URL nobody configured goes. `env` is the HOST environment plus the plan, not
 * the agent's curated one: the entries supersede any host `GIT_CONFIG_*` either way, and that is
 * the part under test. Returns null when every answer is a shadow path, else the reason the run
 * must not start.
 *
 * The unconfigured-URL probe runs in `probeGitDir`, a scratch bare repository of the run's own,
 * addressed with `--git-dir`: it must work where there is no user repository at all, and under
 * `safe.bareRepository=explicit`.
 */
export async function verifyPushRedirect(
  cwd: string,
  remotes: readonly GitRemoteUrls[],
  plan: RedirectPlan,
  env: NodeJS.ProcessEnv,
  probeGitDir: string,
  git: Git = defaultGit,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  for (const remote of remotes) {
    const result = await git(cwd, ['remote', 'get-url', '--push', '--all', remote.name], env);
    const urls = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const target = plan.targets[remote.name];
    if (!result.ok || urls.length === 0 || target === undefined) {
      return `could not confirm where remote "${remote.name}" pushes (${result.stderr.trim().split('\n')[0] || 'no answer from git'})`;
    }
    const leak = urls.find((url) => !samePath(url, target, platform));
    if (leak !== undefined) {
      return `remote "${remote.name}" would still push to ${leak} - git ignored the shadow redirect (git 2.31 or newer is required)`;
    }
  }
  // A push to a URL no remote names must land under the blocked prefix. `remote get-url` cannot
  // answer this - git treats a remote defined only in environment config as "not configured in
  // this repository" - so the probe is a real `push --dry-run` of a ref DELETION (it needs no
  // local commit). Rewritten, git fails on a local path that does not exist and names it; not
  // rewritten, it fails resolving a host that cannot exist. Either way nothing is sent.
  const probe = await git(
    cwd,
    [`--git-dir=${probeGitDir}`, 'push', '--dry-run', '--porcelain', PROBE_URL, ':refs/heads/cezar-shadow-probe'],
    { ...env, GIT_TERMINAL_PROMPT: '0' },
  );
  const said = gitPath(`${probe.stdout}\n${probe.stderr}`);
  const expected = `${plan.blockedBase}/${PROBE_HOST}`;
  const blocked = platform === 'win32' ? said.toLowerCase().includes(expected.toLowerCase()) : said.includes(expected);
  if (probe.ok || !blocked) {
    return `a push to an unconfigured URL would not be blocked (git answered "${(probe.stderr.trim() || probe.stdout.trim()).split('\n')[0]}")`;
  }
  return null;
}
