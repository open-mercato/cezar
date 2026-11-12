/**
 * The manager's read-only shell (spec 2026-10-31-managers, Safety). `isManagerBashAllowed` is the
 * policy: a conservative tokenizer that refuses anything it does not fully understand. Claude
 * enforces it through a PreToolUse hook (`bash-policy-hook.ts`); `MANAGER_BASH_ALLOWLIST` is the
 * prefix floor every fenced backend keeps when that hook cannot run, so it never names `gh api`.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BashVerdict = { ok: true } | { ok: false; reason: string };

export const MANAGER_BASH_ALLOWLIST = [
  'cez-manager',
  'gh pr view', 'gh pr list', 'gh pr diff', 'gh pr checks', 'gh issue view', 'gh issue list', 'gh run view', 'gh run list', 'gh repo view',
  'gh search code', 'gh search commits', 'gh search issues', 'gh search prs', 'gh search repos',
];

const MAX_COMMAND = 4_000;

/** `gh <group> <verb>` that only read. Any flag goes but `--web`, which acts on the desktop. */
const GH_READ: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(['view', 'list', 'diff', 'checks']),
  issue: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  repo: new Set(['view']),
};
const GH_SEARCH = new Set(['code', 'commits', 'issues', 'prs', 'repos']);

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

/**
 * Words and `|` separators, or a reason. Only plain words, single quotes and double quotes without
 * expansion: every other shell metacharacter — `;`, `&`, `$`, backticks, redirects, subshells,
 * globs, newlines — refuses the whole command rather than being interpreted.
 */
export function tokenizeManagerBash(command: string): string[][] | string {
  const segments: string[][] = [[]];
  let word: string | undefined;
  const end = () => {
    if (word !== undefined) segments[segments.length - 1]!.push(word);
    word = undefined;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === ' ' || ch === '\t') {
      end();
    } else if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return 'an unterminated quote';
      const body = command.slice(i + 1, close);
      if (/[\n\r]/.test(body)) return 'a newline';
      word = (word ?? '') + body;
      i = close;
    } else if (ch === '"') {
      let body = '';
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const c = command[j]!;
        if (c === '$' || c === '`') return `\`${c}\` (expansion)`;
        if (c === '\n' || c === '\r') return 'a newline';
        if (c === '\\') {
          const next = command[j + 1];
          if (next !== '"' && next !== '\\') return 'a backslash escape';
          body += next;
          j++;
        } else {
          body += c;
        }
      }
      if (j >= command.length) return 'an unterminated quote';
      word = (word ?? '') + body;
      i = j;
    } else if (ch === '|') {
      if (command[i + 1] === '|') return '`||`';
      end();
      if (segments[segments.length - 1]!.length === 0) return 'an empty pipe stage';
      segments.push([]);
    } else if (/[A-Za-z0-9_.,:/=@%+\-]/.test(ch)) {
      word = (word ?? '') + ch;
    } else {
      return ch === '\n' || ch === '\r' ? 'a newline' : `\`${ch}\``;
    }
  }
  end();
  if (segments[segments.length - 1]!.length === 0) return 'an empty pipe stage';
  return segments;
}

/** Whether a manager may run this shell command, and why not. Pure: no shell, no I/O. */
export function isManagerBashAllowed(command: string): BashVerdict {
  const trimmed = command.trim();
  if (!trimmed) return refuse('empty command');
  if (trimmed.length > MAX_COMMAND) return refuse('command too long');
  const segments = tokenizeManagerBash(trimmed);
  if (typeof segments === 'string') return refuse(`refused shell syntax: ${segments}`);
  const [first, ...filters] = segments;
  const head = primary(first!);
  if (!head.ok) return head;
  for (const stage of filters) {
    const verdict = filter(stage);
    if (!verdict.ok) return verdict;
  }
  return OK;
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
  if (group && verb && GH_READ[group]?.has(verb)) return ghReadFlags(rest);
  return refuse(`\`gh ${[group, verb].filter(Boolean).join(' ')}\` is not read-only`);
}

const GH_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
    const value = flag === arg ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) return refuse(`\`${flag}\` needs a value`);
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
    case 'head': return countOnly(args, ['-n', '-c']);
    case 'wc': return args.every((arg) => /^-[lcwm]+$/.test(arg)) ? OK : refuse('`wc` takes only -l, -c, -w, -m');
    default: return refuse(`\`${program}\` cannot read from a pipe here (only jq, grep, head, wc)`);
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

function countOnly(args: string[], valueFlags: string[]): BashVerdict {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-\d{1,7}$/.test(arg)) continue;
    if (valueFlags.includes(arg) && COUNT.test(args[i + 1] ?? '')) {
      i++;
      continue;
    }
    return refuse(`\`head ${arg}\` is not allowed (only -n N, -c N, -N, and no files)`);
  }
  return OK;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

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
export function managerBashHookDecision(command: unknown): { decision: 'allow' | 'deny'; reason: string } | undefined {
  if (typeof command !== 'string') return { decision: 'deny', reason: 'no command' };
  const verdict = isManagerBashAllowed(command);
  if (verdict.ok) return { decision: 'allow', reason: 'read-only manager command' };
  if (/^\s*cez-manager(\s|$)/.test(command)) return undefined;
  return { decision: 'deny', reason: `cezar manager policy: ${verdict.reason}` };
}
