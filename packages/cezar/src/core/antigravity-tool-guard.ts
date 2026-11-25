/**
 * Enforces `allowedTools`, `bashAllowlist`, and `enforceReadOnly` for the Antigravity CLI (`agy`).
 *
 * Uses two independent layers supported by `agy` (verified against agy 1.5.17):
 * 1. `--settings '{"permissions":{"deny":[...]}}'` — native hard-deny rules that hold even under
 *    `--dangerously-skip-permissions`.
 * 2. `--add-dir <tempDir>` containing `.agents/hooks.json` with a `PreToolUse` (`matcher: "*"`)
 *    hook — intercepts every tool call before execution without modifying the user's repository.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunSpec } from './agent-runner.ts';
import { DEFAULT_ALLOWED_TOOLS } from '../workflows/types.ts';

export interface AntigravityToolPolicy {
  allowedTools?: readonly string[];
  bashAllowlist?: readonly string[];
  enforceReadOnly?: boolean;
}

export interface AntigravityToolGuard {
  settingsJson?: string;
  hookDir?: string;
  cleanup: () => void;
}

/** `agy` tool names → cezar canonical tool names (mirrors `antigravity-ui-mapper.ts`). */
const TOOL_CANONICAL: Readonly<Record<string, string>> = {
  read_file: 'Read',
  view_file: 'Read',
  list_dir: 'Read',
  view_file_outline: 'Read',
  view_code_item: 'Read',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  write_file: 'Write',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  sed_file: 'Edit',
  notebook_edit: 'NotebookEdit',
  run_command: 'Bash',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
  invoke_subagent: 'Task',
};

const READ_ONLY_CANONICAL = new Set(['Read', 'Grep', 'Glob']);
const SHELL_META_RE = /[`$<>;|&\n]|\$\(/;

/** True only when the step restricts tools below the default unrestricted set. */
export function needsAntigravityToolGuard(
  spec: Pick<AgentRunSpec, 'allowedTools' | 'bashAllowlist' | 'enforceReadOnly'>,
): boolean {
  if (spec.enforceReadOnly) return true;
  if (spec.bashAllowlist && spec.bashAllowlist.length > 0) return true;
  if (spec.allowedTools === undefined) return false;
  const allowed = new Set(spec.allowedTools);
  return !DEFAULT_ALLOWED_TOOLS.every((tool) => allowed.has(tool));
}

/** Native `--settings` deny rules layered alongside the `PreToolUse` hook. */
export function antigravitySettingsOverride(
  spec: Pick<AgentRunSpec, 'allowedTools' | 'bashAllowlist' | 'enforceReadOnly'>,
): string | undefined {
  if (!needsAntigravityToolGuard(spec)) return undefined;
  const deny: string[] = [];
  if (spec.enforceReadOnly) {
    deny.push('write_file(*)', 'command(*)', 'mcp(*)');
  } else {
    const allowed = new Set(spec.allowedTools ?? []);
    if (!allowed.has('Write') && !allowed.has('Edit') && !allowed.has('MultiEdit')) {
      deny.push('write_file(*)');
    }
    if (!allowed.has('Bash')) {
      deny.push('command(*)');
    }
    if (![...allowed].some((tool) => tool.startsWith('mcp__'))) {
      deny.push('mcp(*)');
    }
  }
  return deny.length > 0 ? JSON.stringify({ permissions: { deny } }) : undefined;
}

/** Pure evaluator shared by tests and mirrored in the standalone hook script. */
export function evaluateAntigravityToolCall(
  policy: AntigravityToolPolicy,
  rawToolName: string,
  args: Record<string, unknown> = {},
): { decision: 'allow' | 'deny'; reason?: string } {
  const key = rawToolName.toLowerCase();
  const canonical = Object.hasOwn(TOOL_CANONICAL, key) ? TOOL_CANONICAL[key]! : rawToolName;

  if (policy.enforceReadOnly) {
    if (READ_ONLY_CANONICAL.has(canonical)) return { decision: 'allow' };
    return { decision: 'deny', reason: `Tool "${rawToolName}" is not allowed in read-only mode.` };
  }

  const allowed = new Set(policy.allowedTools ?? []);
  const isMcp = key === 'call_mcp_tool' || key.startsWith('mcp__');
  if (isMcp) {
    if (![...allowed].some((tool) => tool.startsWith('mcp__'))) {
      return { decision: 'deny', reason: `MCP tool "${rawToolName}" is not in this step's allowedTools.` };
    }
    return { decision: 'allow' };
  }

  if (!allowed.has(canonical) && !allowed.has(rawToolName)) {
    return { decision: 'deny', reason: `Tool "${rawToolName}" is not in this step's allowedTools.` };
  }

  if (canonical === 'Bash' && policy.bashAllowlist && policy.bashAllowlist.length > 0) {
    const rawCommand = typeof args.CommandLine === 'string' ? args.CommandLine : typeof args.command === 'string' ? args.command : '';
    const cmd = rawCommand.trim().replace(/\s+/g, ' ');
    if (!cmd || SHELL_META_RE.test(rawCommand)) {
      return { decision: 'deny', reason: `Command "${rawCommand}" is not allowed by this step's bashAllowlist.` };
    }
    const ok = policy.bashAllowlist.some((prefix) => {
      const p = prefix.trim().replace(/\s+/g, ' ');
      return cmd === p || cmd.startsWith(`${p} `);
    });
    if (!ok) {
      return { decision: 'deny', reason: `Command "${cmd}" is not allowed by this step's bashAllowlist.` };
    }
  }

  return { decision: 'allow' };
}

function buildHookScript(policy: AntigravityToolPolicy): string {
  const serializedPolicy = JSON.stringify({
    allowedTools: policy.allowedTools ? [...policy.allowedTools] : [],
    bashAllowlist: policy.bashAllowlist ? [...policy.bashAllowlist] : [],
    enforceReadOnly: policy.enforceReadOnly === true,
  });
  const serializedMap = JSON.stringify(TOOL_CANONICAL);
  return `import { readFileSync } from 'node:fs';
const POLICY = ${serializedPolicy};
const MAP = ${serializedMap};
const READ_ONLY = new Set(['Read', 'Grep', 'Glob']);
const META = /[\`$<>;|&\\n]|\\$\\(/;
function decide(name, args) {
  const key = String(name || '').toLowerCase();
  const canonical = Object.prototype.hasOwnProperty.call(MAP, key) ? MAP[key] : String(name || '');
  if (POLICY.enforceReadOnly) {
    return READ_ONLY.has(canonical)
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'Tool "' + name + '" is not allowed in read-only mode.' };
  }
  const allowed = new Set(POLICY.allowedTools);
  if (key === 'call_mcp_tool' || key.startsWith('mcp__')) {
    return [...allowed].some((t) => t.startsWith('mcp__'))
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'MCP tool "' + name + '" is not allowed in this step.' };
  }
  if (!allowed.has(canonical) && !allowed.has(name)) {
    return { decision: 'deny', reason: 'Tool "' + name + '" is not in this step\\'s allowedTools.' };
  }
  if (canonical === 'Bash' && POLICY.bashAllowlist.length > 0) {
    const raw = typeof args?.CommandLine === 'string' ? args.CommandLine : typeof args?.command === 'string' ? args.command : '';
    const cmd = raw.trim().replace(/\\s+/g, ' ');
    if (!cmd || META.test(raw)) {
      return { decision: 'deny', reason: 'Command is not allowed by this step\\'s bashAllowlist.' };
    }
    const ok = POLICY.bashAllowlist.some((prefix) => {
      const p = prefix.trim().replace(/\\s+/g, ' ');
      return cmd === p || cmd.startsWith(p + ' ');
    });
    if (!ok) return { decision: 'deny', reason: 'Command "' + cmd + '" is not allowed by this step\\'s bashAllowlist.' };
  }
  return { decision: 'allow' };
}
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const call = input && input.toolCall ? input.toolCall : {};
  process.stdout.write(JSON.stringify(decide(call.name || '', call.args || {})) + '\\n');
} catch {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Failed to parse PreToolUse hook payload.' }) + '\\n');
}
`;
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Creates the temp `.agents/hooks.json` directory and native `--settings` JSON for a restricted run. */
export function createAntigravityToolGuard(
  spec: Pick<AgentRunSpec, 'allowedTools' | 'bashAllowlist' | 'enforceReadOnly'>,
): AntigravityToolGuard | undefined {
  if (!needsAntigravityToolGuard(spec)) return undefined;
  const settingsJson = antigravitySettingsOverride(spec);
  const hookDir = mkdtempSync(join(tmpdir(), 'cez-agy-guard-'));
  const agentsDir = join(hookDir, '.agents');
  mkdirSync(agentsDir, { recursive: true });
  const scriptPath = join(hookDir, 'hook.mjs');
  writeFileSync(scriptPath, buildHookScript({
    allowedTools: spec.allowedTools,
    bashAllowlist: spec.bashAllowlist,
    enforceReadOnly: spec.enforceReadOnly,
  }), { mode: 0o600 });
  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  writeFileSync(join(agentsDir, 'hooks.json'), JSON.stringify({
    'cezar-tool-guard': {
      enabled: true,
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command, timeout: 10 }],
        },
      ],
    },
  }), { mode: 0o600 });
  let cleaned = false;
  return {
    ...(settingsJson ? { settingsJson } : {}),
    hookDir,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try { rmSync(hookDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
