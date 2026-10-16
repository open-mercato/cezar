import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which remote hosts are GitHub — github.com plus GitHub Enterprise, wherever it lives. A
 * self-hosted GHES can sit on any domain, so the name alone can't decide; zero-config discovery
 * reads what `gh` already knows: the hosts it is signed in to (`hosts.yml`) and `GH_HOST`.
 * `*.ghe.com` (Enterprise Cloud) is GitHub by construction, so it counts without a login and `gh`
 * can say "sign in to <host>" instead of the tab being silently hidden. A bare `github.*` name
 * does not: it is a guess, and a GitLab box called `github.corp` would get a tab that only fails.
 */

export const GITHUB_COM = 'github.com';

const HOSTS_TTL_MS = 30_000;
let cached: { at: number; key: string; hosts: Set<string> } | null = null;

function ghConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh');
  if (process.platform === 'win32' && env.AppData) return join(env.AppData, 'GitHub CLI');
  return join(homedir(), '.config', 'gh');
}

/** Hosts `gh` is configured for: top-level keys of `hosts.yml`, plus `GH_HOST`. Never throws. */
function ghConfiguredHosts(env: NodeJS.ProcessEnv): Set<string> {
  const file = join(ghConfigDir(env), 'hosts.yml');
  const key = `${file}\n${env.GH_HOST ?? ''}`;
  if (cached && cached.key === key && Date.now() - cached.at < HOSTS_TTL_MS) return cached.hosts;
  const hosts = new Set<string>();
  if (env.GH_HOST) hosts.add(env.GH_HOST.trim().toLowerCase());
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^["']?([A-Za-z0-9][A-Za-z0-9.-]*)["']?:\s*(?:#.*)?$/.exec(line);
      if (m?.[1]) hosts.add(m[1].toLowerCase());
    }
  } catch {
    // no gh config: only the name heuristics apply
  }
  cached = { at: Date.now(), key, hosts };
  return hosts;
}

/** A host safe to hand to `gh --hostname` / `GH_HOST` and to build URLs from. */
export function isSafeHostname(host: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) && host.length <= 253;
}

export function isGithubHost(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (!isSafeHostname(h)) return false;
  if (h === GITHUB_COM || h.endsWith('.ghe.com')) return true;
  return ghConfiguredHosts(env).has(h);
}

/** Test seam: forget the cached `hosts.yml` read. */
export function resetGithubHostsCache(): void {
  cached = null;
}
