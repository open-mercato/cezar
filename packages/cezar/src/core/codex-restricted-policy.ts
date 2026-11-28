import { DEFAULT_ALLOWED_TOOLS, type AgentRunSpec, type BrokeredShell } from './agent-runner.ts';
import { CodexToolPolicyError } from './codex-tool-policy.ts';
import { tokenizePlainShell } from './plain-shell.ts';

export const CODEX_DISABLED_FEATURES = ['shell_tool', 'view_image', 'hooks', 'multi_agent', 'multi_agent_v2', 'goals', 'unified_exec_tty', 'shell_snapshot', 'remote_plugin', 'remote_control', 'tool_suggest', 'image_generation', 'js_repl', 'code_mode', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'skill_mcp_dependency_install', 'workspace_dependencies'] as const;

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash']);
// A prefix here is only a grant selector. Each invocation is validated again below.
export const CODEX_READ_PREFIXES = [
  'gh pr view', 'gh pr diff', 'gh pr checks', 'gh pr list', 'gh issue view', 'gh issue list', 'gh repo view',
  'git status', 'git ls-files', 'git rev-parse', 'git merge-base',
] as const;

export interface CodexRestrictedPolicy {
  readonly mutation: 'read-only';
  readonly tools: ReadonlySet<string>;
  readonly bashPrefixes: readonly string[];
  /** A manager's vetted shell: Bash goes through it instead of the git/GitHub read grant. */
  readonly shell?: BrokeredShell;
}

/** Undefined is the historical unrestricted path. Unsupported grants never become unrestricted. */
export function compileCodexRestrictedPolicy(spec: Pick<AgentRunSpec,
  'allowedTools' | 'bashAllowlist' | 'bashHookCommand' | 'enforceReadOnly' | 'mcpServers' | 'brokeredShell'
>): CodexRestrictedPolicy | undefined {
  if (spec.brokeredShell) {
    // The shell's own verifier is the Bash grant; a read-only session never gets one.
    const tools = spec.allowedTools ?? [];
    if (spec.enforceReadOnly || spec.mcpServers?.length || spec.bashHookCommand !== undefined || !tools.includes('Bash') || tools.some(t => !READ_TOOLS.has(t))) throw new CodexToolPolicyError();
    return { mutation: 'read-only', tools: new Set(tools), bashPrefixes: [], shell: spec.brokeredShell };
  }
  const explicit = spec.allowedTools;
  const tools = explicit ?? (spec.enforceReadOnly ? ['Read', 'Grep', 'Glob'] : undefined);
  const legacy = tools === undefined || (tools.length === DEFAULT_ALLOWED_TOOLS.length && DEFAULT_ALLOWED_TOOLS.every(t => tools.includes(t)));
  if (legacy && !spec.enforceReadOnly && spec.bashAllowlist === undefined && spec.bashHookCommand === undefined) return undefined;
  if (spec.mcpServers?.length || spec.bashHookCommand !== undefined || !tools || tools.some(t => !READ_TOOLS.has(t))) throw new CodexToolPolicyError();
  if ((tools.includes('Bash') && !spec.bashAllowlist) || spec.bashAllowlist?.some(p => !(CODEX_READ_PREFIXES as readonly string[]).includes(p))) throw new CodexToolPolicyError();
  return { mutation: 'read-only', tools: new Set(tools), bashPrefixes: [...(spec.bashAllowlist ?? [])] };
}

const ONE_VALUE = new Set(['--json', '--repo', '-R', '--limit', '-L', '--state', '-s', '--base', '-B', '--head', '-H', '--author', '-A', '--assignee', '-a', '--label', '-l', '--search', '-S', '--color']);
const GH_FLAGS = new Set(['--comments', '-c', '--patch', '--name-only', '--required', '--draft']);
const GIT_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  status: new Set(['--short', '-s', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--branch', '-b', '--untracked-files=no', '--untracked-files=all', '--ignored']),
  'ls-files': new Set(['--cached', '-c', '--modified', '-m', '--deleted', '-d', '--others', '-o', '--exclude-standard', '--stage', '-s', '--full-name', '--error-unmatch']),
  'rev-parse': new Set(['--show-toplevel', '--git-dir', '--absolute-git-dir', '--is-inside-work-tree', '--abbrev-ref', '--verify', '--symbolic-full-name', '--short']),
  'merge-base': new Set(['--is-ancestor', '--all', '-a', '--octopus', '--independent']),
};
function flags(args: readonly string[], bare: ReadonlySet<string>, value: ReadonlySet<string> = new Set()): boolean {
  let operandsOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (operandsOnly) continue;
    if (arg === '--') { operandsOnly = true; continue; }
    if (!arg.startsWith('-') || arg === '-') continue;
    if (bare.has(arg)) continue;
    if (value.has(arg) && args[i + 1] !== undefined) { i++; continue; }
    return false;
  }
  return true;
}

function github(args: readonly string[]): boolean {
  if (!flags(args.slice(3), GH_FLAGS, ONE_VALUE)) return false;
  // No browser/editor, aliases, extensions, arbitrary HTTP method, or option-file support.
  return !args.some(a => /^(--web|-w|--watch|--browser|--editor|--hostname)(=|$)/.test(a));
}

function permittedArgv(argv: readonly string[], policy: CodexRestrictedPolicy): boolean {
  const program = argv[0];
  // Accept only names resolved through the sealed runtime PATH, never an executable from the repo.
  if (!program || program.includes('/') || program.includes('\\')) return false;
  if (program === 'gh' || program === 'git') {
    if (!policy.tools.has('Bash')) return false;
    const prefix = program === 'gh' ? argv.slice(0, 3).join(' ') : argv.slice(0, 2).join(' ');
    if (!policy.bashPrefixes.includes(prefix)) return false;
    if (program === 'gh') return github(argv);
    const verb = argv[1]!;
    return !!GIT_FLAGS[verb] && flags(argv.slice(2), GIT_FLAGS[verb]);
  }

  return false;
}

/** No shell is started: this returns one validated argv for the host read broker. */
export function codexBashArgv(command: unknown, policy: CodexRestrictedPolicy): string[] | undefined {
  if (typeof command !== 'string' || command.length > 16_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(command)) return undefined;
  const parsed = tokenizePlainShell(command);
  if (typeof parsed === 'string' || parsed.length !== 1 || !permittedArgv(parsed[0]!, policy)) return undefined;
  return parsed[0];
}

/** Called only after argv validation; separates operands from search/filter flag values. */
export function codexGithubOperands(argv: readonly string[]): string[] {
  const operands: string[] = [];
  let afterDash = false;
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!afterDash && arg === '--') { afterDash = true; continue; }
    if (!afterDash && ONE_VALUE.has(arg)) { i++; continue; }
    if (!afterDash && GH_FLAGS.has(arg)) continue;
    operands.push(arg);
  }
  return operands;
}
