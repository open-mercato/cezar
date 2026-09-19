/**
 * Preset + rules → per-backend permission translation.
 *
 * The spec (2026-07-17-permission-modes, #475) defines four capability-named
 * presets plus optional advanced per-tool rules. This module is the single
 * source of truth for how each maps onto the three backends' native mechanisms.
 *
 * Fidelity contract (spec §Proposed Solution):
 *  - claude: full fidelity — presets, allow/ask/deny channels all supported.
 *  - opencode: tool-level fidelity — specifiers map onto permission keys; unrecognised → note.
 *  - codex: mode-only — rules are not supported; emit an engine note when rules are present.
 */

/** The four presets the user selects. */
export type PermissionMode = 'auto' | 'guarded' | 'read-only' | 'manual';

/** Advanced per-tool rule lists (optional, on top of a preset). */
export interface PermissionRules {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

/**
 * The effective permission specification: a mode plus optional advanced rules.
 * This is the seam that flows through `AgentRunSpec.permissions` into each runner.
 */
export interface PermissionSpec {
  mode: PermissionMode;
  rules?: PermissionRules;
}

// ---- Claude translation ----------------------------------------------------

/**
 * Translated permission args for the Claude Code CLI.
 *
 * Preset mapping (Claude Code `--permission-mode` choices vary by CLI patch:
 * 2.1.252 advertises `manual`; some builds list `default` instead of `manual`.
 * Both mean "prompt for approval". `buildClaudeArgs` remaps to whichever the
 * installed binary advertises):
 *  - auto       → `--dangerously-skip-permissions` (explicit skip-all; NOT the
 *                 zero-config default — absent spec keeps historical `dontAsk`)
 *  - guarded    → `--permission-mode acceptEdits`; Bash in ask via --settings
 *  - read-only  → `--permission-mode manual` + allowlist Read,Grep,Glob
 *  - manual     → `--permission-mode manual`, empty allowlist (everything prompts)
 *
 * Restrictive modes also require `--permission-prompt-tool stdio` so headless
 * Claude emits `can_use_tool` instead of auto-denying.
 *
 * Advanced rules:
 *  - allow → `--allowedTools`
 *  - deny  → `--disallowedTools`
 *  - ask   → `--settings '{"permissions":{"ask":[…]}}'`
 */
export interface ClaudePermissionArgs {
  /** Flag: use `--dangerously-skip-permissions` instead of `--permission-mode`. */
  dangerouslySkipPermissions: boolean;
  /** Value for `--permission-mode` (only set when `dangerouslySkipPermissions` is false). */
  permissionMode?: 'acceptEdits' | 'manual' | 'default' | 'dontAsk' | 'auto' | 'bypassPermissions' | 'plan';
  /** When true, spawn with `--permission-prompt-tool stdio` so `can_use_tool` is routed to us. */
  permissionPromptToolStdio: boolean;
  /** Additional tools to add to `--allowedTools` (merged with spec.allowedTools). */
  additionalAllowedTools: string[];
  /** Tools to add to `--disallowedTools`. */
  disallowedTools: string[];
  /** JSON string for `--settings` to inject ask permissions; undefined when not needed. */
  settingsJson?: string;
}

export function translateClaudePermissions(spec: PermissionSpec): ClaudePermissionArgs {
  const { mode, rules } = spec;

  let dangerouslySkipPermissions = false;
  let permissionMode: ClaudePermissionArgs['permissionMode'];
  let additionalAllowedTools: string[] = [];
  let presetAsk: string[] = [];

  switch (mode) {
    case 'auto':
      dangerouslySkipPermissions = true;
      break;
    case 'guarded':
      permissionMode = 'acceptEdits';
      presetAsk = ['Bash'];
      break;
    case 'read-only':
      // Prompt-for-approval. Canonical advertised name is `manual`; some CLIs
      // list `default` instead — remapped at spawn.
      permissionMode = 'manual';
      additionalAllowedTools = ['Read', 'Grep', 'Glob'];
      presetAsk = ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'];
      break;
    case 'manual':
      permissionMode = 'manual';
      presetAsk = ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
      break;
  }

  const disallowedTools: string[] = rules?.deny ?? [];
  const allowedTools: string[] = rules?.allow ?? [];
  const askTools: string[] = [...presetAsk, ...(rules?.ask ?? [])];

  additionalAllowedTools = [...additionalAllowedTools, ...allowedTools];

  const settingsJson =
    askTools.length > 0 ? JSON.stringify({ permissions: { ask: askTools } }) : undefined;

  return {
    dangerouslySkipPermissions,
    permissionMode,
    additionalAllowedTools,
    disallowedTools,
    settingsJson,
    permissionPromptToolStdio: !dangerouslySkipPermissions,
  };
}

const CLAUDE_PERMISSION_MODE_NAMES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
  'default',
] as const;

/** Parse `--permission-mode` choices out of `claude --help` / the invalid-arg error. */
export function parseClaudePermissionModeChoices(text: string): Set<string> {
  const into = new Set<string>();
  const block = /permission-mode[\s\S]{0,400}?(?:choices are |choices:\s*)([^\n]+)/i.exec(text);
  const haystack = block?.[1] ?? text;
  for (const name of CLAUDE_PERMISSION_MODE_NAMES) {
    if (haystack.includes(name)) into.add(name);
  }
  return into;
}

/**
 * `manual` (advertised on 2.1.252) and `default` (some other 2.x builds) are
 * the same prompt-for-approval mode under two names. Pick the one this binary
 * lists; if the probe returned nothing, keep the canonical `manual`.
 */
export function remapClaudePermissionMode(
  mode: NonNullable<ClaudePermissionArgs['permissionMode']>,
  advertised: Set<string>,
): NonNullable<ClaudePermissionArgs['permissionMode']> {
  if (mode !== 'manual' && mode !== 'default') return mode;
  if (advertised.size === 0) return mode;
  if (advertised.has(mode)) return mode;
  if (mode === 'manual' && advertised.has('default')) return 'default';
  if (mode === 'default' && advertised.has('manual')) return 'manual';
  return mode;
}

/** Union two rule lists, preserving order and dropping duplicates. */
function unionRuleList(base?: string[], extra?: string[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...(base ?? []), ...(extra ?? [])]) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

export function mergePermissionRules(
  base?: PermissionRules,
  extra?: PermissionRules,
): PermissionRules | undefined {
  if (!base && !extra) return undefined;
  const allow = unionRuleList(base?.allow, extra?.allow);
  const ask = unionRuleList(base?.ask, extra?.ask);
  const deny = unionRuleList(base?.deny, extra?.deny);
  if (!allow && !ask && !deny) return undefined;
  return {
    ...(allow ? { allow } : {}),
    ...(ask ? { ask } : {}),
    ...(deny ? { deny } : {}),
  };
}

/**
 * Per-task override supplies the mode; configured rules always ride along.
 * Either side missing → the other; both missing → `undefined` (historical
 * zero-config posture, not skip-all).
 */
export function mergePermissionSpecs(
  override: PermissionSpec | undefined,
  fallback: PermissionSpec | undefined,
): PermissionSpec | undefined {
  if (!override) return fallback;
  if (!fallback) return override;
  const rules = mergePermissionRules(fallback.rules, override.rules);
  return { mode: override.mode, ...(rules ? { rules } : {}) };
}

// ---- Codex translation -----------------------------------------------------

/**
 * Translated permission args for `codex app-server` (`thread/start`).
 *
 * Docs (Agent approvals & security / Config reference): sandbox × approval are
 * orthogonal. Official presets:
 *  - Auto (recommended) → `workspace-write` + `on-request`
 *  - Full access / yolo → `danger-full-access` + `never`
 *  - Read-only          → `read-only` + `on-request`
 *  - `approval_policy = "untrusted"` is **retired** (can prevent clients from
 *    starting); `on-failure` is deprecated. Use `on-request` or `never`.
 *
 * Cezar preset mapping:
 *  - auto      → full access (`danger-full-access` + `never`) — not Codex "Auto"
 *  - guarded   → Codex Auto (`workspace-write` + `on-request`)
 *  - read-only → `read-only` + `on-request`
 *  - manual    → same as read-only (`untrusted` dropped per docs migration)
 */
export type CodexApprovalPolicy =
  | 'never'
  | 'on-request'
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export interface CodexPermissionArgs {
  sandbox: 'danger-full-access' | 'workspace-write' | 'read-only';
  approvalPolicy: CodexApprovalPolicy;
  /** Non-null when advanced rules were provided but ignored (codex doesn't support them). */
  engineNote: string | null;
}

/** All granular approval categories allowed to surface (docs `approval_policy.granular`). */
const MANUAL_GRANULAR: Extract<CodexApprovalPolicy, { granular: unknown }> = {
  granular: {
    sandbox_approval: true,
    rules: true,
    skill_approval: true,
    request_permissions: true,
    mcp_elicitations: true,
  },
};

export function translateCodexPermissions(spec: PermissionSpec): CodexPermissionArgs {
  const { mode, rules } = spec;
  const hasRules =
    (rules?.allow && rules.allow.length > 0) ||
    (rules?.ask && rules.ask.length > 0) ||
    (rules?.deny && rules.deny.length > 0);

  let sandbox: CodexPermissionArgs['sandbox'];
  let approvalPolicy: CodexPermissionArgs['approvalPolicy'];

  switch (mode) {
    case 'auto':
      // Cezar "auto" = Codex full access / --yolo, not the CLI "Auto" preset.
      sandbox = 'danger-full-access';
      approvalPolicy = 'never';
      break;
    case 'guarded':
      // Codex recommended "Auto" preset.
      sandbox = 'workspace-write';
      approvalPolicy = 'on-request';
      break;
    case 'read-only':
      sandbox = 'read-only';
      approvalPolicy = 'on-request';
      break;
    case 'manual':
      // Retired `untrusted` → read-only sandbox + granular approvals so every
      // prompt category can still surface (stricter than plain on-request alone).
      sandbox = 'read-only';
      approvalPolicy = MANUAL_GRANULAR;
      break;
  }

  const engineNote = hasRules
    ? `advanced permission rules are not supported by codex — ${mode} preset applied`
    : null;

  return { sandbox, approvalPolicy, engineNote };
}

// ---- OpenCode translation --------------------------------------------------

/**
 * One OpenCode `POST /session` permission rule (OpenCode ≥1.18 Ruleset).
 * Config-file object syntax (`{ bash: "allow" }`) is NOT accepted on create —
 * the HTTP schema wants `{ permission, pattern, action }[]` or you get 400
 * `{"_tag":"BadRequest"}`.
 */
export interface OpencodePermissionRule {
  permission: string;
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
}

/**
 * Translated permission config for `opencode serve`.
 *
 * Preset mapping (opencode's per-tool `allow | ask | deny`):
 *  - auto      → all `allow`
 *  - guarded   → `edit: allow`, `bash: ask`, `webfetch: ask`
 *  - read-only → `edit: ask`, `bash: ask`
 *  - manual    → all `ask`
 *
 * Advanced rules: specifiers are mapped to opencode permission keys where
 * possible. Unrecognised specifiers produce an engine note.
 */
export interface OpencodePermissionConfig {
  permissions: OpencodePermissionRule[];
  /** Non-null when any specifiers were unrecognised and dropped. */
  engineNote: string | null;
}

const OPENCODE_TOOL_MAP: Record<string, string> = {
  Bash: 'bash',
  Edit: 'edit',
  Write: 'edit',
  WebFetch: 'webfetch',
  WebSearch: 'webfetch',
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
};

function parseSpecifier(specifier: string): { toolName: string; pattern: string } {
  const m = /^(.*?)\((.*)\)$/.exec(specifier);
  if (m) return { toolName: m[1]!, pattern: m[2]! };
  return { toolName: specifier, pattern: '*' };
}

function toRuleset(map: Record<string, 'allow' | 'ask' | 'deny'>): OpencodePermissionRule[] {
  return Object.entries(map).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

export function translateOpencodePermissions(spec: PermissionSpec): OpencodePermissionConfig {
  const { mode, rules } = spec;
  let permissions: Record<string, 'allow' | 'ask' | 'deny'> = {};

  switch (mode) {
    case 'auto':
      permissions = { bash: 'allow', edit: 'allow', webfetch: 'allow', read: 'allow' };
      break;
    case 'guarded':
      permissions = { edit: 'allow', bash: 'ask', webfetch: 'ask', read: 'allow' };
      break;
    case 'read-only':
      permissions = { edit: 'ask', bash: 'ask', webfetch: 'ask', read: 'allow' };
      break;
    case 'manual':
      permissions = { bash: 'ask', edit: 'ask', webfetch: 'ask', read: 'ask' };
      break;
  }

  const unrecognised: string[] = [];
  // Pattern-scoped advanced rules append on top of the preset (last match wins
  // in OpenCode). Flat tool overrides still replace the preset entry.
  const extras: OpencodePermissionRule[] = [];

  function applyRuleList(list: string[] | undefined, value: 'allow' | 'ask' | 'deny'): void {
    for (const specifier of list ?? []) {
      const { toolName, pattern } = parseSpecifier(specifier);
      const key = OPENCODE_TOOL_MAP[toolName];
      if (!key) {
        unrecognised.push(specifier);
        continue;
      }
      if (pattern === '*') {
        permissions[key] = value;
      } else {
        extras.push({ permission: key, pattern, action: value });
      }
    }
  }

  applyRuleList(rules?.allow, 'allow');
  applyRuleList(rules?.ask, 'ask');
  applyRuleList(rules?.deny, 'deny');

  const engineNote =
    unrecognised.length > 0
      ? `opencode: unrecognised permission specifiers dropped (${unrecognised.join(', ')}) — ${mode} preset applied for unlisted tools`
      : null;

  return { permissions: [...toRuleset(permissions), ...extras], engineNote };
}
