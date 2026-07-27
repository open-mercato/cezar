import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentHomePaths } from './agent-config/catalog.js';

/**
 * Per-user cezar home. Literal `~/.cezar` on every platform (no XDG, no
 * `%LOCALAPPDATA%` branch) — one rule, and it matches how the existing cache
 * path already behaves (`skills-remote.ts` hardcodes `~/.cache/cez`).
 *
 * `CEZ_HOME` overrides the base so tests (and containers) never touch a real
 * home dir. This is the first shared home-path helper in the repo; two other
 * 2026-07-16 specs (multi-project-switcher, agent-config-files) extend it —
 * first writer owns the file, later specs import it. Do not duplicate this
 * homedir logic elsewhere.
 */
export function cezarHomeDir(): string {
  // `|| undefined` so an EMPTY CEZ_HOME (e.g. `CEZ_HOME= cezar …`) falls back
  // to the default instead of yielding relative paths in the cwd.
  return (process.env.CEZ_HOME || undefined) ?? join(homedir(), '.cezar');
}

/**
 * The default server-install instance id. An install with no `--domain` (the
 * original single-cockpit-per-host flow) is this instance, and it keeps the
 * legacy `~/.cezar/server.json` path so existing hosts upgrade in place.
 */
export const DEFAULT_SERVER_INSTANCE = 'default';

/**
 * Turn a public domain into a stable, filesystem- and systemd-safe instance
 * slug — the key that lets one host run several independent cockpits, each for
 * a different domain (nginx site `cezar-<slug>`, unit `cezar-<slug>.service`,
 * state file `server-instances/<slug>.json`). Lowercased; every run of
 * non-`[a-z0-9]` becomes a single `-`; leading/trailing `-` trimmed. A `.` in a
 * systemd unit name is a type separator, so dots collapse to `-` too. Returns
 * `default` for empty/degenerate input so a bad value can never escape the
 * instance namespace.
 */
export function instanceSlug(domain: string | undefined | null): string {
  const slug = String(domain ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || DEFAULT_SERVER_INSTANCE;
}

/** The directory holding per-domain (named) server-install state files. */
export function serverInstancesDir(): string {
  return join(cezarHomeDir(), 'server-instances');
}

/**
 * Host-level record written by `server-install` (spec 2026-07-16-server-installer).
 * The `default` instance keeps the original `~/.cezar/server.json`; a named
 * (domain-keyed) instance lives at `~/.cezar/server-instances/<slug>.json`, so
 * a second install for a different domain never resumes or clobbers the first.
 * Distinct from the per-user project registry the multi-project workspace keeps
 * inside `~/.cezar/config.json` (see `workspaceConfigPath`) — they coexist.
 */
export function serverStatePath(instance: string = DEFAULT_SERVER_INSTANCE): string {
  if (instance === DEFAULT_SERVER_INSTANCE) return join(cezarHomeDir(), 'server.json');
  return join(serverInstancesDir(), `${instance}.json`);
}

/**
 * Per-user workspace config (spec 2026-07-20-multi-project-workspace): schema
 * version, global defaults, and the project registry — every repo cezar has
 * been booted in. Lives directly under `cezarHomeDir()`, so the `CEZ_HOME`
 * override applies (tests/containers never touch a real home dir).
 */
export function workspaceConfigPath(): string {
  return join(cezarHomeDir(), 'config.json');
}

/**
 * Global GUI state — the workspace twin of the per-repo
 * `.ai/cezar/ui-state.json`. Cross-project UI prefs live here; per-project
 * state (pinned runs, templates) stays in each repo's file.
 */
export function workspaceUiStatePath(): string {
  return join(cezarHomeDir(), 'ui-state.json');
}

/**
 * Expand a leading `~` to the user's home. Lives here with the other homedir
 * logic (see the module note above — one place owns `homedir()`): the
 * workspace browse/checkout roots are stored as the user wrote them (a literal `~`), so
 * every consumer that must touch the REAL directory — the writability probe on
 * `PUT /api/workspace/config`, the browse root in
 * `src/server/fs-browse.ts` — expands it through this one helper.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Single-writer lock the installer/uninstaller hold for a whole run. Per
 * instance, so installing/uninstalling one cockpit never blocks work on another
 * on the same host. The host-level installer is not concurrency-safe with
 * itself *for the same instance*.
 */
export function serverLockPath(instance: string = DEFAULT_SERVER_INSTANCE): string {
  if (instance === DEFAULT_SERVER_INSTANCE) return join(cezarHomeDir(), 'server.install.lock');
  return join(serverInstancesDir(), `${instance}.install.lock`);
}

/**
 * Where each coding agent keeps its per-user config, honouring the env vars the
 * vendors document: `$CODEX_HOME` relocates Codex's home; `$XDG_CONFIG_HOME`
 * relocates OpenCode's config dir (falling back to `~/.config`). Claude's `~/.claude`
 * has no documented override. Read per call so tests and ops can set env live.
 */
export function agentHomePaths(env: NodeJS.ProcessEnv = process.env): AgentHomePaths {
  const home = env.HOME || env.USERPROFILE || homedir();
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return {
    claude: join(home, '.claude'),
    codex: env.CODEX_HOME?.trim() || join(home, '.codex'),
    opencodeConfig: join(xdgConfig, 'opencode'),
  };
}
