import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSafeHostname } from './github-hosts.ts';

/**
 * Which remote hosts are GitLab — gitlab.com plus any self-managed instance `glab` knows. The
 * twin of `github-hosts.ts` (#1426) and deliberately the same mechanism: a synchronous,
 * TTL-cached read of what the CLI already wrote to disk (the `hosts:` map in `glab`'s
 * `config.yml`) plus the env vars `glab` itself honors. No subprocess, no network, no cache file
 * of cezar's own (spec 2026-08-10-forge-provider-adapters § Forge discovery).
 */

export const GITLAB_COM = 'gitlab.com';

const HOSTS_TTL_MS = 30_000;
let cached: { at: number; key: string; hosts: Set<string> } | null = null;

/** `glab`'s config dir: `GLAB_CONFIG_DIR`, else `$XDG_CONFIG_HOME/glab-cli`, else
 *  `~/.config/glab-cli` — on every platform, which is where `glab` itself looks. */
function glabConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.GLAB_CONFIG_DIR) return env.GLAB_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'glab-cli');
  return join(homedir(), '.config', 'glab-cli');
}

/** `GITLAB_HOST` / `GL_HOST` may be a bare host or a URL (`glab` accepts both). */
function envHost(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The keys of the top-level `hosts:` map in `config.yml`, plus the top-level default `host:`.
 * A line-level read, not a YAML parser: `glab` writes this file itself, one host key per line at
 * the first indent under `hosts:`. Never throws.
 */
export function parseGlabConfigHosts(text: string): string[] {
  const hosts: string[] = [];
  let inHosts = false;
  let childIndent: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inHosts = /^hosts:\s*(?:#.*)?$/.test(line);
      childIndent = null;
      const top = /^host:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line);
      if (top?.[1]) hosts.push(top[1].toLowerCase());
      continue;
    }
    if (!inHosts) continue;
    childIndent ??= indent;
    if (indent !== childIndent) continue;
    const m = /^\s+["']?([A-Za-z0-9][A-Za-z0-9.-]*)["']?:\s*(?:#.*)?$/.exec(line);
    if (m?.[1]) hosts.push(m[1].toLowerCase());
  }
  return hosts;
}

/** Hosts `glab` is configured for: its `config.yml` hosts, plus `GITLAB_HOST` / `GL_HOST`. */
function glabConfiguredHosts(env: NodeJS.ProcessEnv): Set<string> {
  const file = join(glabConfigDir(env), 'config.yml');
  const key = `${file}\n${env.GITLAB_HOST ?? ''}\n${env.GL_HOST ?? ''}`;
  if (cached && cached.key === key && Date.now() - cached.at < HOSTS_TTL_MS) return cached.hosts;
  const hosts = new Set<string>();
  for (const raw of [env.GITLAB_HOST, env.GL_HOST]) {
    const host = envHost(raw);
    if (host) hosts.add(host);
  }
  try {
    for (const host of parseGlabConfigHosts(readFileSync(file, 'utf8'))) hosts.add(host);
  } catch {
    // no glab config: only gitlab.com counts
  }
  cached = { at: Date.now(), key, hosts };
  return hosts;
}

export function isGitlabHost(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (!isSafeHostname(h)) return false;
  if (h === GITLAB_COM) return true;
  return glabConfiguredHosts(env).has(h);
}

/** Test seam: forget the cached `config.yml` read. */
export function resetGitlabHostsCache(): void {
  cached = null;
}
