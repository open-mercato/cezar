/**
 * The manager's read-only shell (spec 2026-10-31-managers, Safety). `isManagerBashAllowed` is the
 * policy: a conservative tokenizer that refuses anything it does not fully understand. Claude
 * enforces it through a PreToolUse hook (`bash-policy-hook.ts`); `MANAGER_BASH_ALLOWLIST` is the
 * prefix floor every fenced backend keeps when that hook cannot run, so it never names `gh api`.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizePlainShell as tokenizeManagerBash } from '../core/plain-shell.ts';
import type { BrokeredShellPlan } from '../core/agent-runner.ts';

export { tokenizeManagerBash };

export type BashVerdict = { ok: true } | { ok: false; reason: string };

/** `gh <group> <verb>` that only read. Any flag goes but `--web`, which acts on the desktop. */
const GH_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']),
  issue: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  repo: new Set(['view']),
};
const GH_SEARCH = new Set(['code', 'commits', 'issues', 'prs', 'repos']);
/** Programs a read may pipe into; each reads only the pipe. */
export const MANAGER_BASH_FILTERS = ['jq', 'grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut'] as const;

/** Writes the manager must leave to a task or a proposal card; a user-allowed pattern never covers one. */
export const MANAGER_BASH_DENIED = [
  'gh pr merge', 'gh pr review', 'gh pr comment', 'gh pr edit', 'gh pr close', 'gh pr ready',
  'gh issue comment', 'gh issue edit', 'gh issue close', 'gh workflow run', 'gh run rerun', 'git push',
];

export const MANAGER_BASH_ALLOWLIST = [
  'cez-manager',
  ...Object.entries(GH_READ).flatMap(([group, verbs]) => [...verbs].map((verb) => `gh ${group} ${verb}`)),
  ...[...GH_SEARCH].map((kind) => `gh search ${kind}`),
];

/** Over the CLI's own ~10,000-character refusal, so that refusal is the one the manager reads. */
const MAX_COMMAND = 12_000;

/** `gh api` flags that cannot change the request into a write or another host. */
const GH_API_VALUE_FLAGS = new Set(['-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--cache']);
const GH_API_BARE_FLAGS = new Set(['--paginate', '--slurp', '-i', '--include', '--silent']);
const GH_API_HEADERS = /^(accept|x-github-api-version)\s*:/i;
const GH_API_ENDPOINT = /^\/?[A-Za-z0-9_.\-/{}]+(\?[A-Za-z0-9_.\-/%=&+,:]*)?$/;

const JQ_BARE_FLAGS = new Set([
  '-r', '--raw-output', '-c', '--compact-output', '-e', '--exit-status', '-s', '--slurp', '-j', '--join-output',
  '-a', '--ascii-output', '-S', '--sort-keys', '-C', '--color-output', '-M', '--monochrome-output', '--tab',
]);
const JQ_VALUE_FLAGS = new Set(['--indent']);
const JQ_PAIR_FLAGS = new Set(['--arg', '--argjson']);
/** jq builtins that reach past stdin: the environment, module files, the input's file name. */
const JQ_UNSAFE = /\$ENV\b|\benv\b|\$__loc__|\binput_filename\b|\bimport\b|\binclude\b|\bmodulemeta\b|\bget_search_list\b/;

const GREP_BARE_FLAGS = new Set(['-i', '-v', '-n', '-c', '-E', '-F', '-w', '-x', '-o', '-q', '-s', '-h']);
const GREP_VALUE_FLAGS = new Set(['-m', '-A', '-B', '-C', '-e']);
const COUNT = /^\d{1,7}$/;

const refuse = (reason: string): BashVerdict => ({ ok: false, reason });
const OK: BashVerdict = { ok: true };

/** Whether a manager may run this shell command, and why not. Pure: no shell, no I/O. `allowed`
 *  are the user's own read-only patterns (`managerBashPatternIssue` vets them). */
export function isManagerBashAllowed(command: string, allowed: readonly string[] = []): BashVerdict {
  const trimmed = command.trim();
  if (!trimmed) return refuse('empty command');
  if (trimmed.length > MAX_COMMAND) return refuse('command too long');
  const heredoc = splitHeredoc(trimmed);
  if (typeof heredoc === 'string') return refuse(`refused shell syntax: ${heredoc}`);
  const segments = tokenizeManagerBash(heredoc?.head ?? trimmed);
  if (typeof segments === 'string') return refuse(`refused shell syntax: ${segments}`);
  const [first, ...filters] = segments;
  if (heredoc && (first![0] !== 'cez-manager' || filters.length > 0)) return refuse('a heredoc goes only to a lone `cez-manager` command');
  const denied = deniedPrefix(first!);
  if (denied) return refuse(`\`${denied}\` is not read-only`);
  const head = primary(first!);
  if (!head.ok && !userAllowed(first!, allowed)) return head;
  for (const stage of filters) {
    const verdict = filter(stage);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

/** `<command> <<'EOF'` + literal body + `EOF`: a quoted delimiter expands nothing, so the body is
 *  data. Anything after the closing line would be a second command and refuses. */
function splitHeredoc(command: string): { head: string; body: string } | string | undefined {
  const match = /^([^\n]*?)[ \t]*<<[ \t]*(['"])([A-Za-z_]\w{0,31})\2[ \t]*\n([\s\S]*)$/.exec(command);
  if (!match) return undefined;
  const [, head, , delimiter, rest] = match;
  const lines = rest!.split('\n');
  const close = lines.indexOf(delimiter!);
  if (close < 0) return 'an unterminated heredoc';
  if (lines.slice(close + 1).some((line) => line.trim() !== '')) return 'a command after a heredoc';
  return { head: head!, body: lines.slice(0, close).map((line) => `${line}\n`).join('') };
}

const words = (argv: string[], count: number): string => argv.slice(0, count).join(' ');

function deniedPrefix(argv: string[]): string | undefined {
  return MANAGER_BASH_DENIED.find((prefix) => words(argv, prefix.split(' ').length) === prefix);
}

/** gh's own groups a user may allow a read of. Any other name may be an extension or a `!` alias,
 *  i.e. any program; auth, config, secret, codespace and the like show credentials or act locally. */
const GH_ALLOWABLE = new Set(['agent-task', 'cache', 'gist', 'issue', 'label', 'org', 'pr', 'project', 'release', 'repo', 'ruleset', 'run', 'workflow']);
const GH_READ_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks']);

/** Why a user pattern cannot be allowed, or undefined. Only `gh <group> <read verb>`: anything wider
 *  cannot be proved read-only from its prefix. */
export function managerBashPatternIssue(pattern: string): string | undefined {
  const argv = pattern.trim().split(/\s+/);
  if (argv.length !== 3 || argv[0] !== 'gh' || !argv.every((word) => /^[a-z][a-z0-9-]{0,39}$/.test(word))) {
    return 'only a `gh <group> <verb>` pattern can be allowed';
  }
  if (!GH_ALLOWABLE.has(argv[1]!)) return `\`gh ${argv[1]}\` cannot be allowed (only ${[...GH_ALLOWABLE].join(', ')})`;
  if (!GH_READ_VERBS.has(argv[2]!)) return `\`${argv[2]}\` is not a read-only verb (${[...GH_READ_VERBS].join(', ')})`;
  if (deniedPrefix(argv)) return `\`${pattern}\` is not read-only`;
  // A built-in read keeps its own, stricter checks (`gh repo view`'s HOST/OWNER/REPO).
  if (MANAGER_BASH_ALLOWLIST.includes(pattern.trim())) return `\`${pattern}\` is already allowed`;
  return undefined;
}

/** The pattern a refused command would need, when the user may allow it at all. */
export function managerBashSuggestion(command: string): string | undefined {
  const segments = tokenizeManagerBash(command.trim());
  if (typeof segments === 'string') return undefined;
  const pattern = words(segments[0]!, 3);
  if (managerBashPatternIssue(pattern) !== undefined) return undefined;
  return pattern;
}

function userAllowed(argv: string[], allowed: readonly string[]): boolean {
  const pattern = words(argv, 3);
  if (!allowed.includes(pattern) || managerBashPatternIssue(pattern) !== undefined) return false;
  // The same flag and host checks as the built-in reads.
  const rest = argv.slice(3);
  return ghReadFlags(rest).ok && !rest.some(namesOtherHost);
}

function primary(argv: string[]): BashVerdict {
  const [program, ...args] = argv;
  if (program === 'cez-manager') return OK; // its server enforces every approval gate
  if (program !== 'gh') return refuse(`\`${program}\` is not a read-only command a manager may run`);
  const [group, verb, ...rest] = args;
  if (group === 'api') return ghApi(args.slice(1));
  if (group === 'search') {
    if (!verb || !GH_SEARCH.has(verb)) return refuse(`\`gh search ${verb ?? ''}\` is not allowed`);
    return ghReadFlags(rest);
  }
  if (group && verb && GH_READ[group]?.has(verb)) {
    const flags = ghReadFlags(rest);
    if (!flags.ok) return flags;
    const host = rest.find((arg) => (group === 'repo' && mayNameHost(arg) && ((arg.match(/\//g) ?? []).length > 1 || /^\S*@\S*:/.test(arg))) || namesOtherHost(arg));
    return host === undefined ? OK : refuse(`\`${host}\` names a host other than github.com`);
  }
  return refuse(`\`gh ${[group, verb].filter(Boolean).join(' ')}\` is not read-only`);
}

const GH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A `host.tld/…` / `host:port/…` path: gh sends a PR, issue or repo argument to that host.
 *  `gh repo view` also reads HOST/OWNER/REPO and scp-style `git@HOST:OWNER/REPO`, refused above. */
const GH_HOST_PATH = /^[^/:]*\.[^/:]*\/|^[^/]*:\d+\//;
/** Any `scheme://` not followed by `github.com/`; Go's URL parser takes spaces in a path. */
const foreignUrl = (arg: string): boolean => arg.split('://').slice(1).some((rest) => !rest.startsWith('github.com/'));
/** No host holds these, so a word whose first `/`- or `:`-segment does is not a target (`--jq '.a // "x"'`).
 *  Only that segment: HOST/OWNER/REPO and scp `git@HOST:…` accept them anywhere after the host (#2222). */
const mayNameHost = (arg: string): boolean => !/[\s|()"']/.test(arg.split(/[/:]/)[0]!);
const namesOtherHost = (arg: string): boolean => foreignUrl(arg) || (mayNameHost(arg) && GH_HOST_PATH.test(arg));

/** No `--web` (it acts on the desktop), `--jq` only without env/file builtins (gh's gojq reads
 *  `$ENV`), and `--repo` only as OWNER/REPO (HOST/OWNER/REPO sends a request to that host). */
function ghReadFlags(args: string[]): BashVerdict {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // gh clusters short flags (`-cw`, `-cR x`, `-w=1`): -w, -R and -q must stand alone.
    if (/^-[A-Za-z]/.test(arg) && /[wRq]/.test(arg) && arg !== '-R' && arg !== '-q') {
      return refuse(/w/.test(arg) ? '`--web` opens a browser' : `\`${arg}\`: write -R and -q as separate flags`);
    }
    if (arg === '--web' || arg.startsWith('--web=')) return refuse('`--web` opens a browser');
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (flag !== '-q' && flag !== '--jq' && flag !== '-R' && flag !== '--repo') continue;
    // Peek, never skip: this scan does not know every flag's arity, so a value-taking flag before
    // (`--search -q --web`) can make gh read the next word differently than we do. Check both ways.
    const value = flag === arg ? args[i + 1] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith('-')) return refuse(`\`${flag}\` needs a value`);
    if ((flag === '-q' || flag === '--jq') && JQ_UNSAFE.test(value)) return refuse('a jq expression that reads the environment or files');
    if ((flag === '-R' || flag === '--repo') && !GH_REPO.test(value)) return refuse(`\`${flag} ${value}\` must be OWNER/REPO`);
  }
  return OK;
}

function ghApi(args: string[]): BashVerdict {
  let endpoint: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let flag = arg;
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else if (/^-[XHqt]./.test(arg)) {
      flag = arg.slice(0, 2);
      value = arg.slice(2);
    }
    if (GH_API_BARE_FLAGS.has(flag) && value === undefined) continue;
    if (GH_API_VALUE_FLAGS.has(flag)) {
      if (value === undefined) value = args[++i];
      if (value === undefined) return refuse(`\`${flag}\` needs a value`);
      if ((flag === '-X' || flag === '--method') && value.toUpperCase() !== 'GET') return refuse(`\`gh api\` may only GET, not ${value}`);
      if ((flag === '-H' || flag === '--header') && !GH_API_HEADERS.test(value)) return refuse(`header \`${value}\` is not allowed`);
      if ((flag === '-q' || flag === '--jq') && JQ_UNSAFE.test(value)) return refuse('a jq expression that reads the environment or files');
      continue;
    }
    if (arg.startsWith('-')) return refuse(`\`gh api ${flag}\` is not allowed (it can write or leave GitHub)`);
    if (endpoint !== undefined) return refuse('`gh api` takes one endpoint');
    endpoint = arg;
  }
  if (endpoint === undefined) return refuse('`gh api` needs an endpoint');
  if (/^\/?graphql$/i.test(endpoint.split('?')[0]!)) return refuse('`gh api graphql` is a POST');
  if (!GH_API_ENDPOINT.test(endpoint)) return refuse(`endpoint \`${endpoint}\` is not a plain API path`);
  return OK;
}

function filter(argv: string[]): BashVerdict {
  const [program, ...args] = argv;
  switch (program) {
    case 'jq': return jq(args);
    case 'grep': return grep(args);
    case 'head':
    case 'tail': return countOnly(program, args, ['-n', '-c']);
    case 'wc': return args.every((arg) => /^-[lcwm]+$/.test(arg)) ? OK : refuse('`wc` takes only -l, -c, -w, -m');
    // No -o (writes a file), no file operands: only letter flags and -k/-t values.
    case 'sort': return flagsOnly(program, args, /^-[bdfgnrsuV]+$/, new Set(['-k', '-t']));
    case 'uniq': return flagsOnly(program, args, /^-[cdiu]+$/, new Set(['-f', '-s']));
    case 'cut': return flagsOnly(program, args, /^-[s]+$/, new Set(['-f', '-d', '-c', '-b']));
    default: return refuse(`\`${program}\` cannot read from a pipe here (only ${MANAGER_BASH_FILTERS.join(', ')})`);
  }
}

function jq(args: string[]): BashVerdict {
  let program: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (JQ_BARE_FLAGS.has(arg)) continue;
    if (JQ_VALUE_FLAGS.has(arg)) {
      if (!COUNT.test(args[++i] ?? '')) return refuse(`\`jq ${arg}\` needs a number`);
      continue;
    }
    if (JQ_PAIR_FLAGS.has(arg)) {
      if (!/^[A-Za-z_]\w*$/.test(args[i + 1] ?? '') || args[i + 2] === undefined) return refuse(`\`jq ${arg}\` needs a name and a value`);
      i += 2;
      continue;
    }
    if (arg.startsWith('-')) return refuse(`\`jq ${arg}\` is not allowed`);
    if (program !== undefined) return refuse('`jq` reads only the pipe, not files');
    program = arg;
  }
  if (program === undefined) return refuse('`jq` needs a filter');
  if (JQ_UNSAFE.test(program)) return refuse('a jq filter that reads the environment or files');
  return OK;
}

function grep(args: string[]): BashVerdict {
  let pattern = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (GREP_BARE_FLAGS.has(arg)) continue;
    if (/^-[ivncEFwxoqsh]+$/.test(arg)) continue;
    if (GREP_VALUE_FLAGS.has(arg)) {
      const value = args[++i];
      if (value === undefined) return refuse(`\`grep ${arg}\` needs a value`);
      if (arg === '-e') pattern = true;
      else if (!COUNT.test(value)) return refuse(`\`grep ${arg}\` needs a number`);
      continue;
    }
    if (arg.startsWith('-')) return refuse(`\`grep ${arg}\` is not allowed`);
    if (pattern) return refuse('`grep` reads only the pipe, not files');
    pattern = true;
  }
  return pattern ? OK : refuse('`grep` needs a pattern');
}

function flagsOnly(program: string, args: string[], bare: RegExp, valueFlags: ReadonlySet<string>): BashVerdict {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (bare.test(arg)) continue;
    if (valueFlags.has(arg) && args[i + 1] !== undefined) {
      i++;
      continue;
    }
    // `-k2,2`, `-f1`, `-d,`: a value flag with its value attached.
    if (valueFlags.has(arg.slice(0, 2)) && arg.length > 2) continue;
    return refuse(`\`${program} ${arg}\` is not allowed (no files)`);
  }
  return OK;
}

function countOnly(program: string, args: string[], valueFlags: string[]): BashVerdict {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-\d{1,7}$/.test(arg)) continue;
    // `tail -n +5`: from line 5 on.
    if (valueFlags.includes(arg) && /^\+?\d{1,7}$/.test(args[i + 1] ?? '')) {
      i++;
      continue;
    }
    return refuse(`\`${program} ${arg}\` is not allowed (only -n N, -c N, -N, and no files)`);
  }
  return OK;
}

/** The system prompt's account of this policy, built from the same tables so the two cannot drift. */
export function managerBashPromptSection(allowed: readonly string[] = [], options: { textInFiles?: boolean } = {}): string {
  const reads = Object.entries(GH_READ).map(([group, verbs]) => `gh ${group} ${[...verbs].join('|')}`).join(', ');
  const own = allowed.filter((pattern) => managerBashPatternIssue(pattern) === undefined);
  return `Bash runs only these, one command per call (no ;, &&, ||, $(…), backticks, redirects or loops):
  cez-manager <command>                               below
  ${reads}
  gh search ${[...GH_SEARCH].join('|')}
  gh api <endpoint>                                   GET only: no -X/--method but GET, no -f/-F/--field/--raw-field/--input, no graphql${own.length > 0 ? `\n  ${own.join(', ')}    (the user allowed these)` : ''}
  any of them may pipe into ${MANAGER_BASH_FILTERS.join(', ')} (reading the pipe, never a file); --jq and --template work too
  never: ${MANAGER_BASH_DENIED.join(', ')}, gh api writes, --web, or any other program; a refused command is shown to the user
  ${options.textInFiles ? MANAGER_TEXT_IN_FILES : "long or multi-line text: put it in single quotes, or end the command with --stdin <<'EOF', the text, and EOF on its own line"}`;
}

/** The same policy as a plan Codex's broker runs (#2330): the argv pipeline it vetted and a heredoc
 *  body as stdin. Nothing goes through a shell, so nothing is interpreted after this check. */
export function managerShellPlan(command: string, allowed: readonly string[] = []): BrokeredShellPlan {
  const verdict = isManagerBashAllowed(command, allowed);
  if (!verdict.ok) return verdict;
  const trimmed = command.trim();
  const heredoc = splitHeredoc(trimmed);
  if (typeof heredoc === 'string') return { ok: false, reason: `refused shell syntax: ${heredoc}` };
  const pipeline = tokenizeManagerBash(heredoc?.head ?? trimmed);
  if (typeof pipeline === 'string') return { ok: false, reason: `refused shell syntax: ${pipeline}` };
  return { ok: true, pipeline, ...(heredoc ? { stdin: heredoc.body } : {}) };
}

/** What a Codex manager's Bash tool is for, in its tool description. */
export const MANAGER_SHELL_DESCRIPTION = 'a `cez-manager` command, or a read-only `gh` command (pr/issue/run/release view|list, pr diff|checks|status, repo view, search, `gh api` GET) optionally piped into jq, grep, head, tail, wc, sort, uniq or cut. A `cez-manager` command may take a quoted heredoc (<<\'EOF\') for long text.';

/** Claude Code's Bash sandbox lets `cez-manager` out only for a plain command (#2258): a heredoc,
 *  `?`, `*`, `[`, `~` or a newline keeps it sandboxed, and the call fails. */
export const MANAGER_TEXT_IN_FILES =
  'any text you write for a task (an objective, a message): never inline it or use a heredoc; write it with Write to files/<name>.md, then pass --file files/<name>.md. Keep every other argument (titles, reasons) to plain words, without ? * [ ~ or line breaks: anything else can make the call fail';

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** How the engine hands the user's patterns to the hook process (through Claude's environment). */
export const MANAGER_BASH_ALLOW_ENV = 'CEZ_MANAGER_BASH_ALLOW';

/** The patterns in that variable; anything unreadable is no pattern. */
export function managerBashAllowFromEnv(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** The hook's shell command, or undefined where it cannot run (the prefix floor then decides). */
export function managerBashHookCommand(): string | undefined {
  if (process.platform === 'win32') return undefined;
  const self = fileURLToPath(import.meta.url);
  const hook = join(dirname(self), `bash-policy-hook${extname(self)}`);
  if (!existsSync(hook)) return undefined;
  // A dev cockpit runs under tsx: the hook needs the same loader flags, as the `cez-manager` shim does.
  const flags = process.execArgv.filter((arg) => !arg.startsWith('--inspect'));
  return [process.execPath, ...flags, hook].map(shellQuote).join(' ');
}

/** A Claude PreToolUse answer: allow what the policy allows, deny the rest. `cez-manager` that the
 *  tokenizer cannot read (a heredoc for `--stdin`) gets no answer, so Claude's own prefix rule and
 *  compound-command check decide it, as before this policy existed. */
export function managerBashHookDecision(command: unknown, allowed: readonly string[] = []): { decision: 'allow' | 'deny'; reason: string } | undefined {
  if (typeof command !== 'string') return { decision: 'deny', reason: 'no command' };
  const verdict = isManagerBashAllowed(command, allowed);
  if (verdict.ok) return { decision: 'allow', reason: 'read-only manager command' };
  if (/^\s*cez-manager(\s|$)/.test(command)) return undefined;
  return { decision: 'deny', reason: `cezar manager policy: ${verdict.reason}` };
}
