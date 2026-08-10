import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { AgentHomePaths } from './agent-config/catalog.ts';

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
export function cezarHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  // `|| undefined` so an EMPTY CEZ_HOME (e.g. `CEZ_HOME= cezar …`) falls back
  // to the default instead of yielding relative paths in the cwd.
  return (env.CEZ_HOME || undefined) ?? join(homedir(), '.cezar');
}

/**
 * The last line of defence for the developer's own `~/.cezar` while the suite
 * runs. Every workspace test pins `CEZ_HOME` to a temp dir, but the pin lives
 * in `process.env` — a single global for the whole worker. A test that ends
 * before its write does (a timeout is enough) has its `afterEach` drop the pin
 * while the write is still in flight, and the write then resolves the REAL
 * home and replaces the developer's project registry with the fixture's.
 *
 * So writers into the cezar home ask here first: under vitest, a write whose
 * destination is the real `~/.cezar` is always a leaked test, never intent —
 * fail it loudly instead of rewriting a file the suite does not own. Outside
 * vitest this is a no-op, and an explicitly pinned `CEZ_HOME` (the temp dir the
 * test meant to use) never matches the real home, so honest tests are unaffected.
 */
export function assertCezarHomeWriteIsSandboxed(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.VITEST) return;
  const realHome = join(homedir(), '.cezar');
  if (path !== realHome && !path.startsWith(realHome + sep)) return;
  throw new Error(
    `[cez] refusing to write ${path} from a test run — CEZ_HOME is not pinned to a sandbox. ` +
      'Pin it (the vitest setup file does this by default) so the suite never touches the real cezar home.',
  );
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
export function workspaceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'config.json');
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
 * Agent accounts — extra config dirs for a second login of the same agent CLI, plus which one
 * each project uses (spec `2026-07-29-agent-profiles.md`).
 *
 * Its OWN file rather than a key in `config.json`, and that is the whole point: a cezar version
 * that has never heard of accounts does not open this file, so it cannot drop them. Living in
 * `config.json` made their survival depend on a `.passthrough()` in *another version's* source —
 * a guarantee this repo cannot make on behalf of a build the user might switch to, and one that
 * evaporates entirely the moment any version fails to parse that file and degrades to defaults
 * (the next merge-write then rewrites it without them).
 *
 * The per-project selections live here too, beside the accounts they name, so deleting an account
 * and scrubbing every reference to it stays ONE atomic write.
 */
export function agentAccountsPath(): string {
  return join(cezarHomeDir(), 'agent-accounts.json');
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
 * vendors document: `$CLAUDE_CONFIG_DIR` relocates Claude Code's home;
 * `$CODEX_HOME` relocates Codex's; `$XDG_CONFIG_HOME` relocates OpenCode's config
 * dir (falling back to `~/.config`). Read per call so tests and ops can set env live.
 *
 * These are the DEFAULT profile's dirs. A second login of the same CLI is an
 * agent profile (`src/core/agent-profiles.ts`) and resolves through
 * `agentHomePathsForProfiles` instead — what this function answers is what the
 * host is configured for when nothing overrides it.
 */
export function agentHomePaths(env: NodeJS.ProcessEnv = process.env): AgentHomePaths {
  const home = env.HOME || env.USERPROFILE || homedir();
  const xdgConfig = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  return {
    claude: env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
    codex: env.CODEX_HOME?.trim() || join(home, '.codex'),
    opencodeConfig: join(xdgConfig, 'opencode'),
  };
}

/**
 * Where Claude Code keeps `.claude.json` — its MCP/state file — for a given config dir. The
 * location is NOT uniform: by default the file is a SIBLING of `~/.claude`, but under a
 * `CLAUDE_CONFIG_DIR` override it moves INSIDE the overridden dir (verified against the shipped CLI
 * 2026-07-29, and against a real second-account dir on disk). Reading it from `dirname(configDir)`
 * unconditionally — as this repo did — lands on `~/.claude.json` for a `~/.claude-klaudiusz`
 * profile, i.e. the wrong account's file.
 *
 * The condition below reads like two heuristics OR-ed together; it is one exact rule. The file sits
 * inside precisely when the CLI will SEE `CLAUDE_CONFIG_DIR` for this dir, and cezar knows when
 * that is:
 *
 *   - a stored account is always spawned with it (`profileEnv`), and its dir is by construction not
 *     `~/.claude` — the route refuses a dir that is already the discovered account's;
 *   - the DISCOVERED account is spawned with nothing added, so it sees the variable only when the
 *     cezar process itself carries one — and it does reach the child, because `CLAUDE_` is in
 *     `BACKEND_ALLOW_PREFIXES`.
 *
 * One case is worth naming because it looks like a bug and is not. Start cezar with
 * `CLAUDE_CONFIG_DIR=/opt/work` and add `~/.claude` as a NAMED account (legal — the discovered
 * account is `/opt/work`, so `~/.claude` is not a duplicate). This answers `~/.claude/.claude.json`,
 * not the sibling `~/.claude.json`, and "Show details" can therefore say "not signed in" for a
 * folder a bare `claude` would treat as signed in. That is correct rather than unfortunate: cezar
 * will run that account as `CLAUDE_CONFIG_DIR=~/.claude claude`, and under that invocation the
 * state file the CLI reads and writes IS the one inside. Reporting the sibling would describe a
 * login this account will never use.
 */
export function claudeStateFilePath(claudeHome: string, env: NodeJS.ProcessEnv = process.env): string {
  const seesOverride = (env.CLAUDE_CONFIG_DIR?.trim() || '') !== ''
    || claudeHome !== join(env.HOME || env.USERPROFILE || homedir(), '.claude');
  return seesOverride ? join(claudeHome, '.claude.json') : join(dirname(claudeHome), '.claude.json');
}
