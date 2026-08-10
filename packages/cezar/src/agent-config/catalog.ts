import { join } from 'node:path';
import type { RunnerId } from '../core/agent-runner.ts';

/**
 * The catalog of coding-agent config files cezar can surface and edit (spec
 * `.ai/specs/2026-07-16-agent-config-files.md`). This file is the ONLY place
 * vendor knowledge lives: where each agent keeps its files, at which scope, in
 * what format, and — the load-bearing part — the vendor's OWN documented
 * precedence, quoted so a UI label never claims a merge cezar does not perform.
 *
 * Hardcoding is the design. cezar's value here is knowing where the files are
 * and what the docs say; an unknown file is not shown rather than guessed at.
 * A raw editor cannot drift on a vendor's *schema*; it can drift on *paths and
 * precedence strings*, so every entry carries a `docsUrl` and this table is the
 * single maintenance surface. Facts verified against primary docs 2026-07-16.
 */

export type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'markdown';
export type ConfigScope = 'user' | 'project' | 'local';
/** `settings` = behavior knobs; `memory` = instruction/markdown; `mcp` = a dedicated MCP file. */
export type ConfigKind = 'settings' | 'memory' | 'mcp';
/**
 * Git status *by convention* — it drives the honest label, it is not read from
 * git. The seed path re-checks with `git check-ignore` before trusting it.
 */
export type ConfigTracked = 'tracked' | 'gitignored' | 'outside-repo';

/** Resolved home directories per agent, injected so the catalog stays pure and testable. */
export interface AgentHomePaths {
  /** `~/.claude` */
  claude: string;
  /** `$CODEX_HOME` or `~/.codex` */
  codex: string;
  /** `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` */
  opencodeConfig: string;
}

export interface ConfigFileDef {
  /** Stable, opaque, URL-safe. The ONLY thing a client may name (traversal-proof). */
  id: string;
  /** Every runner that reads this file. `<repo>/AGENTS.md` is one file, two readers. */
  runners: RunnerId[];
  kind: ConfigKind;
  scope: ConfigScope;
  /** Absolute path, resolved per request so `$CODEX_HOME`/`$XDG_CONFIG_HOME` are honoured. */
  resolve: (repoRoot: string, home: AgentHomePaths) => string;
  /** What the user sees, e.g. `~/.claude/settings.json`, `.claude/settings.local.json`. */
  label: string;
  format: ConfigFormat;
  tracked: ConfigTracked;
  /** True only for Claude's gitignored personal layer — the files seeded into a run's worktree. */
  seeded?: boolean;
  /** True when this file holds MCP server definitions (drives the MCP section's filter). */
  holdsMcp?: boolean;
  /** Top-level native setting that supplies the agent's new-session model, when present. */
  modelKey?: string;
  /** Native model keys checked in precedence order, including nested `env.*` settings. */
  modelKeys?: readonly string[];
  /** Native provider key paired with the model, when the vendor separates the two. */
  modelProviderKey?: string;
  /** Higher values win when resolving a native default model across config scopes. */
  modelPriority?: number;
  /** VERBATIM from the vendor docs. Never computed, never generic. */
  precedence: string;
  /** Documented mid-run reload behaviour, or undefined when the vendor is silent. */
  hotReload?: string;
  docsUrl: string;
}

const CLAUDE_SETTINGS_DOCS = 'https://code.claude.com/docs/en/settings';
const CLAUDE_MEMORY_DOCS = 'https://code.claude.com/docs/en/memory';
const CLAUDE_MCP_DOCS = 'https://code.claude.com/docs/en/mcp';
const CODEX_CONFIG_DOCS = 'https://developers.openai.com/codex/config-reference';
const CODEX_AGENTS_DOCS = 'https://developers.openai.com/codex/guides/agents-md';
const OPENCODE_CONFIG_DOCS = 'https://opencode.ai/docs/config/';
const OPENCODE_RULES_DOCS = 'https://opencode.ai/docs/rules/';

/**
 * The table. Order is presentation order: per runner, then user → project →
 * local so each scope ladder reads top (broad) to bottom (specific).
 */
export const CONFIG_FILES: ConfigFileDef[] = [
  // ---- Claude Code ----
  {
    id: 'claude.user.settings',
    runners: ['claude'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(home.claude, 'settings.json'),
    label: '~/.claude/settings.json',
    format: 'json',
    tracked: 'outside-repo',
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 1,
    precedence:
      'Lowest priority. Project and local settings override it key by key — except permission rules, which merge across all scopes.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.project.settings',
    runners: ['claude'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.claude', 'settings.json'),
    label: '.claude/settings.json',
    format: 'json',
    tracked: 'tracked',
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 2,
    precedence:
      'Overrides user settings key by key (permission rules merge). Local settings override this.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.local.settings',
    runners: ['claude'],
    kind: 'settings',
    scope: 'local',
    resolve: (repo) => join(repo, '.claude', 'settings.local.json'),
    label: '.claude/settings.local.json',
    format: 'json',
    tracked: 'gitignored',
    seeded: true,
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 3,
    precedence:
      'Highest of the file scopes — overrides project and user (permission rules merge). Git-ignored; copied into each run’s worktree so it takes effect immediately.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.project.mcp',
    runners: ['claude'],
    kind: 'mcp',
    scope: 'project',
    resolve: (repo) => join(repo, '.mcp.json'),
    label: '.mcp.json',
    format: 'json',
    tracked: 'tracked',
    holdsMcp: true,
    precedence:
      'Project-scoped MCP servers (key: mcpServers), shared via version control. Each requires approval before use; user- and local-scoped servers live in ~/.claude.json, which cezar does not edit.',
    docsUrl: CLAUDE_MCP_DOCS,
  },
  {
    id: 'claude.user.memory',
    runners: ['claude'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(home.claude, 'CLAUDE.md'),
    label: '~/.claude/CLAUDE.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence: 'Not overridden — every CLAUDE.md that loads is concatenated, this user file first.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },
  {
    id: 'claude.project.memory',
    runners: ['claude'],
    kind: 'memory',
    scope: 'project',
    resolve: (repo) => join(repo, 'CLAUDE.md'),
    label: 'CLAUDE.md',
    format: 'markdown',
    tracked: 'tracked',
    precedence:
      'Concatenated after the user file, not replacing it. Claude does not read AGENTS.md — import it here with @AGENTS.md. Runs read the committed copy.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },
  {
    id: 'claude.local.memory',
    runners: ['claude'],
    kind: 'memory',
    scope: 'local',
    resolve: (repo) => join(repo, 'CLAUDE.local.md'),
    label: 'CLAUDE.local.md',
    format: 'markdown',
    tracked: 'gitignored',
    seeded: true,
    precedence:
      'Loads alongside CLAUDE.md, concatenated last. Git-ignored; copied into each run’s worktree so it takes effect immediately.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },

  // ---- Codex ----
  {
    id: 'codex.user.config',
    runners: ['codex'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(home.codex, 'config.toml'),
    label: '~/.codex/config.toml',
    format: 'toml',
    tracked: 'outside-repo',
    holdsMcp: true,
    modelKey: 'model',
    modelProviderKey: 'model_provider',
    modelPriority: 1,
    precedence:
      'User-level defaults. A trusted project’s .codex/config.toml overrides these; some keys (provider, auth, telemetry) cannot be overridden at project scope. MCP servers live here under [mcp_servers.<id>].',
    docsUrl: CODEX_CONFIG_DOCS,
  },
  {
    id: 'codex.project.config',
    runners: ['codex'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.codex', 'config.toml'),
    label: '.codex/config.toml',
    format: 'toml',
    tracked: 'tracked',
    modelKey: 'model',
    modelPriority: 2,
    holdsMcp: true,
    precedence:
      'Applies only in projects you have trusted. Some keys (provider, auth, telemetry) cannot be overridden here. MCP servers go under [mcp_servers.<id>]. Runs read the committed copy.',
    docsUrl: CODEX_CONFIG_DOCS,
  },
  {
    id: 'codex.user.memory',
    runners: ['codex'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(home.codex, 'AGENTS.md'),
    label: '~/.codex/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global instructions, read first (an AGENTS.override.md beside it wins if present). Project AGENTS.md files are concatenated after and override it.',
    docsUrl: CODEX_AGENTS_DOCS,
  },

  // ---- OpenCode ----
  {
    id: 'opencode.user.config',
    runners: ['opencode'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(home.opencodeConfig, 'opencode.json'),
    label: '~/.config/opencode/opencode.json',
    format: 'jsonc',
    tracked: 'outside-repo',
    holdsMcp: true,
    modelKey: 'model',
    modelPriority: 1,
    precedence:
      'Global config. Merged with the project config, not replaced — later configs override earlier ones only for conflicting keys. MCP servers live under the "mcp" key.',
    docsUrl: OPENCODE_CONFIG_DOCS,
  },
  {
    id: 'opencode.project.config',
    runners: ['opencode'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, 'opencode.json'),
    label: 'opencode.json',
    format: 'jsonc',
    tracked: 'tracked',
    holdsMcp: true,
    modelKey: 'model',
    modelPriority: 2,
    precedence:
      'Merged over the global config per conflicting key (not a wholesale replace). MCP servers live under the "mcp" key. Runs read the committed copy.',
    docsUrl: OPENCODE_CONFIG_DOCS,
  },
  {
    id: 'opencode.user.memory',
    runners: ['opencode'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(home.opencodeConfig, 'AGENTS.md'),
    label: '~/.config/opencode/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global rules. First match wins across scopes: if a project AGENTS.md exists, this global file is not read at all.',
    docsUrl: OPENCODE_RULES_DOCS,
  },

  // ---- Shared: <repo>/AGENTS.md is read by BOTH Codex and OpenCode ----
  {
    id: 'project.agents',
    runners: ['codex', 'opencode'],
    kind: 'memory',
    scope: 'project',
    resolve: (repo) => join(repo, 'AGENTS.md'),
    label: 'AGENTS.md',
    format: 'markdown',
    tracked: 'tracked',
    precedence:
      'Read by Codex and OpenCode (Claude ignores it). Codex concatenates it root-down; OpenCode uses the first match and prefers it over CLAUDE.md. Runs read the committed copy.',
    docsUrl: OPENCODE_RULES_DOCS,
  },
];

/** The whole catalog. */
export function listConfigFiles(): ConfigFileDef[] {
  return CONFIG_FILES;
}

/** Look up one entry by its stable id, or undefined when the id is unknown. */
export function findConfigFile(id: string): ConfigFileDef | undefined {
  return CONFIG_FILES.find((f) => f.id === id);
}
