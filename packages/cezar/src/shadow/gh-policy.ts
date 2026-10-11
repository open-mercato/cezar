/**
 * Which `gh` invocations a shadow run may execute (spec `2026-10-06-shadow-runs` § The gh policy).
 *
 * The shim on a shadow run's PATH asks this one question for every `gh` call the agent makes:
 * run it (a read), record it (a write), or refuse it (credentials and the user's own gh setup).
 * The server asks it AGAIN for every recorded intent on every read of the ledger, because the
 * ledger is written by processes the agent controls - a stored verdict is never trusted, only the
 * raw argv is.
 *
 * Pure and table-driven, so the whole policy is reviewable in one screen and testable without a
 * `gh` binary. It fails CLOSED: a command it does not know is a write that only a human may run,
 * which costs an agent one recorded no-op and never costs the user an unreviewed side effect.
 *
 * Two classes of write, because "a human approved it" is not one decision:
 *  - `click`: cezar may run it after one confirmation - it opens or annotates something and is
 *    undone by closing or editing it (a PR, an issue, a comment).
 *  - `manual`: cezar never runs it, even approved; the cockpit shows the exact command. Merges,
 *    approvals, anything under `gh api`, releases, repository settings - the acts AGENTS.md says
 *    cezar never performs on its own ("never auto-merges").
 */

export type GhEffect = 'read' | 'write' | 'deny';
export type GhPromotable = 'click' | 'manual' | 'never';

export interface GhVerdict {
  effect: GhEffect;
  /** `never` for a read (there is nothing to promote) and for a denial. */
  promotable: GhPromotable;
  /** The words that selected the policy row: `pr create`, `api`, `auth token`, `(unknown)`. */
  command: string;
  reason: string;
}

interface Row {
  effect: GhEffect;
  promotable: GhPromotable;
  reason: string;
}

const READ: Row = { effect: 'read', promotable: 'never', reason: 'read-only: runs normally' };
const LOCAL: Row = { effect: 'read', promotable: 'never', reason: 'changes only this machine: runs normally' };
const click = (reason: string): Row => ({ effect: 'write', promotable: 'click', reason });
const manual = (reason: string): Row => ({ effect: 'write', promotable: 'manual', reason });
const deny = (reason: string): Row => ({ effect: 'deny', promotable: 'never', reason });

const UNKNOWN = manual('not in the shadow policy: recorded, and only ever run by hand');

interface Group {
  /** Subcommands that only read (or only touch this machine). */
  reads: readonly string[];
  /** Subcommands with their own row. Anything else in the group is `other`. */
  rows?: Readonly<Record<string, Row>>;
  /** The row for a subcommand this table does not name. Defaults to UNKNOWN (fail closed). */
  other?: Row;
}

/**
 * The table. Written against the `gh` 2.x command groups; a group or subcommand added by a later
 * `gh` falls to UNKNOWN, which is the point - a new verb is reviewed before it is trusted.
 */
const GROUPS: Readonly<Record<string, Group>> = {
  pr: {
    reads: ['list', 'view', 'status', 'diff', 'checks', 'checkout'],
    rows: {
      create: click('opens a pull request'),
      comment: click('comments on a pull request'),
      edit: click('edits a pull request'),
      ready: click('marks a draft pull request ready for review'),
      close: click('closes a pull request (reopenable)'),
      reopen: click('reopens a pull request'),
      review: click('reviews a pull request'), // `--approve` is refined to manual below
      merge: manual('merging is never automatic: cezar never auto-merges'),
      'update-branch': manual('rewrites the pull request branch on GitHub'),
      revert: manual('opens a revert of merged work'),
      lock: manual('locks a conversation'),
      unlock: manual('unlocks a conversation'),
    },
  },
  issue: {
    reads: ['list', 'view', 'status'],
    rows: {
      create: click('opens an issue'),
      comment: click('comments on an issue'), // `--delete-last` is refined to manual below
      edit: click('edits an issue'),
      close: click('closes an issue (reopenable)'),
      reopen: click('reopens an issue'),
      develop: manual('creates a linked branch on GitHub'),
      delete: manual('deletes an issue: irreversible'),
      transfer: manual('moves an issue to another repository'),
    },
    other: manual('changes issue state on GitHub'),
  },
  repo: {
    reads: ['list', 'view', 'clone'],
    rows: { 'set-default': LOCAL },
    other: manual('changes a repository on GitHub'),
  },
  api: { reads: [] }, // classified by method and body, see classifyApi
  auth: {
    reads: ['status'], // `--show-token` is refined to deny below
    other: deny('touches GitHub credentials'),
  },
  browse: { reads: [], other: READ },
  cache: { reads: ['list'], other: manual('deletes Actions caches') },
  codespace: { reads: ['list', 'view', 'logs', 'ports'], other: manual('creates or changes a billed codespace') },
  completion: { reads: [], other: READ },
  config: { reads: ['get', 'list'], other: deny("changes the user's own gh configuration") },
  extension: { reads: ['list', 'search', 'browse'], other: deny('installs or runs gh extensions (code execution)') },
  alias: { reads: ['list'], other: deny('aliases can run shell commands') },
  gist: { reads: ['list', 'view', 'clone'], other: manual('publishes or changes a gist') },
  'gpg-key': { reads: ['list'], other: deny('changes account keys') },
  'ssh-key': { reads: ['list'], other: deny('changes account keys') },
  label: { reads: ['list'], other: manual('changes repository labels') },
  org: { reads: ['list'], other: UNKNOWN },
  project: {
    reads: ['list', 'view', 'field-list', 'item-list'],
    other: manual('changes a GitHub project board'),
  },
  release: {
    reads: ['list', 'view', 'download', 'verify', 'verify-asset'],
    other: manual('publishes or changes a release'),
  },
  ruleset: { reads: ['list', 'view', 'check'], other: UNKNOWN },
  run: { reads: ['list', 'view', 'watch', 'download'], other: manual('re-runs, cancels or deletes workflow runs') },
  search: { reads: [], other: READ },
  secret: { reads: ['list'], other: deny('sets or deletes secrets') },
  status: { reads: [], other: READ },
  variable: { reads: ['list', 'get'], other: manual('sets or deletes Actions variables') },
  workflow: { reads: ['list', 'view'], other: manual('runs, enables or disables workflows') },
  attestation: { reads: ['verify', 'download', 'trusted-root'], other: UNKNOWN },
  version: { reads: [], other: READ },
};

/** Alternative spellings gh itself accepts for a group. */
const GROUP_ALIASES: Readonly<Record<string, string>> = {
  cs: 'codespace',
  ext: 'extension',
  extensions: 'extension',
  rs: 'ruleset',
};

/** Built-in shorthands for a whole command (`gh co` is `gh pr checkout`). */
const COMMAND_ALIASES: Readonly<Record<string, readonly [string, string]>> = {
  co: ['pr', 'checkout'],
};

/** Commands with no subcommand: whatever follows them is their own flags and arguments. */
const LEAF_COMMANDS = new Set(['api', 'browse', 'status', 'completion', 'version', ...Object.keys(COMMAND_ALIASES)]);

/**
 * The group and its subcommand, read the way gh itself would - or `canonical: false` when the
 * argv is in a form this table will not try to read.
 *
 * gh resolves subcommands with cobra, which treats an UNKNOWN flag before the subcommand as
 * taking a value: in `gh pr -t create merge 42`, gh runs `merge`, while a reader that skips flags
 * sees `create`. So the only thing allowed between a group and its subcommand is the repository
 * selector (`-R <v>`, `--repo <v>`, `--repo=<v>`), and a group must come first. Anything else is
 * not canonical, and the caller fails closed.
 */
function parseCommand(argv: readonly string[]): { words: string[]; canonical: boolean } {
  const group = argv[0];
  if (group === undefined || group.startsWith('-')) return { words: [], canonical: false };
  if (LEAF_COMMANDS.has(group)) return { words: [group], canonical: true };
  let i = 1;
  while (i < argv.length) {
    const token = argv[i] as string;
    if (token === '-R' || token === '--repo') i += 2;
    else if (token.startsWith('--repo=')) i += 1;
    else break;
  }
  const sub = argv[i];
  if (sub === undefined) return { words: [group], canonical: true };
  if (sub.startsWith('-')) return { words: [group], canonical: false };
  return { words: [group, sub], canonical: true };
}

/** A single-dash token longer than `-x`: a cluster (`-ab`) or an attached value (`-a=true`,
 *  `-Fbody.md`). pflag accepts both, and either can hide a flag a reader looking for `-a` misses. */
function isShortCluster(token: string): boolean {
  return token.length > 2 && token.startsWith('-') && !token.startsWith('--');
}

/**
 * `gh <...> --help` is a read, but ONLY when help flags are all there is besides the command words.
 * Matching a `-h` anywhere would let `gh issue create --body -h` - a write whose body is the
 * string `-h` - pass through as "help".
 */
function isHelpOnly(argv: readonly string[]): boolean {
  if (argv[0] === 'help') return true;
  const flags = argv.filter((token) => token.startsWith('-'));
  const positionals = argv.filter((token) => !token.startsWith('-'));
  return flags.length > 0 && positionals.length <= 2 && flags.every((f) => f === '-h' || f === '--help');
}

/**
 * Does argv carry this flag in ANY spelling gh accepts? Used only by refinements, which make a row
 * stricter, so it over-approximates on purpose: a short flag counts when it appears inside any
 * cluster or attached value (`-ab`, `-a=true`, even `-bapproved`), because pflag reads `-ab` as
 * `-a -b` and a refinement that missed it would let an approval through as a comment.
 */
function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return argv.some((token) =>
    names.some((name) => {
      if (token === name) return true;
      if (name.startsWith('--')) return token.startsWith(`${name}=`);
      return isShortCluster(token) && token.slice(1).includes(name.slice(1));
    }),
  );
}

/** Long options of `gh api` that take a value and are not a body, and those that take none. */
const API_LONG_VALUE = new Set(['--header', '--jq', '--template', '--cache', '--hostname', '--preview']);
const API_LONG_BOOLEAN = new Set(['--paginate', '--slurp', '--silent', '--verbose', '--include']);
/** Short options of `gh api` that take a value and are not a body. `-i` is its only switch. */
const API_SHORT_VALUE = new Set(['H', 'q', 't', 'p']);

/**
 * `gh api` by method and body. The method gh will use is `-X/--method` when given, else POST as
 * soon as any field or input is supplied, else GET (gh's own rule). GraphQL always POSTs, so it is
 * read by its query text: a mutation is a write, and a query read from a FILE cannot be told apart
 * and fails closed.
 */
function classifyApi(rest: readonly string[]): Row {
  let method: string | undefined;
  let endpoint: string | undefined;
  // One object rather than three `let`s: the field helper below assigns them from a closure, and
  // control-flow narrowing does not see assignments made there.
  const body: { present: boolean; query?: string; fromFile: boolean } = { present: false, fromFile: false };
  const field = (value: string, typed: boolean) => {
    body.present = true;
    const eq = value.indexOf('=');
    if (eq > 0 && value.slice(0, eq) === 'query') {
      const raw = value.slice(eq + 1);
      if (typed && raw.startsWith('@')) body.fromFile = true;
      else body.query = raw;
    }
  };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      const attached = eq === -1 ? undefined : token.slice(eq + 1);
      const value = () => {
        if (attached !== undefined) return attached;
        i += 1;
        return rest[i] ?? '';
      };
      if (name === '--method') method = value();
      else if (name === '--raw-field' || name === '--field') field(value(), name === '--field');
      else if (name === '--input') {
        value();
        body.present = true;
        body.fromFile = true; // a body read from a file may carry a mutation this cannot see
      } else if (API_LONG_VALUE.has(name)) value();
      else if (!API_LONG_BOOLEAN.has(name)) return manual(`gh api with an option this policy does not know (${name}): run it by hand`);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      // pflag reads `-XPOST`, `-X=POST`, `-fkey=val` and `-F=key=val` as attached values.
      const letter = token[1] as string;
      const attached = token.length > 2 ? token.slice(2).replace(/^=/, '') : undefined;
      const value = () => {
        if (attached !== undefined) return attached;
        i += 1;
        return rest[i] ?? '';
      };
      if (letter === 'X') method = value();
      else if (letter === 'f' || letter === 'F') field(value(), letter === 'F');
      else if (API_SHORT_VALUE.has(letter)) value();
      else if (letter === 'i' && token.length === 2) continue;
      // `-iXPOST` and any other cluster: pflag would read flags this loop cannot see.
      else return manual(`gh api with a short option this policy cannot read (${token}): run it by hand`);
      continue;
    }
    endpoint ??= token;
  }
  if (endpoint === 'graphql') {
    if (body.fromFile || body.query === undefined) {
      return manual('GraphQL whose query is not inline: a mutation cannot be ruled out');
    }
    return /\bmutation\b/i.test(body.query) ? manual('a GraphQL mutation') : READ;
  }
  const effective = (method ?? (body.present ? 'POST' : 'GET')).toUpperCase();
  if (effective === 'GET' || effective === 'HEAD') return READ;
  return manual(`gh api ${effective}: raw API writes are never run automatically`);
}

/** Refinements that make ONE subcommand stricter depending on its flags. */
function refine(group: string, sub: string, argv: readonly string[], row: Row): Row {
  if (group === 'pr' && sub === 'review' && hasFlag(argv, '-a', '--approve')) {
    return manual('an approval is a human act: never automatic');
  }
  if ((group === 'issue' || group === 'pr') && sub === 'comment' && hasFlag(argv, '--delete-last')) {
    return manual('deletes a comment: irreversible');
  }
  if (group === 'auth' && sub === 'status' && hasFlag(argv, '-t', '--show-token')) {
    return deny('would print a GitHub token');
  }
  return row;
}

export function classifyGh(argv: readonly string[]): GhVerdict {
  if (argv.length === 0) return { ...READ, command: '(none)' };
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) return { ...READ, command: 'version' };
  if (isHelpOnly(argv)) return { ...READ, command: 'help' };

  const { words, canonical } = parseCommand(argv);
  const [first, second] = words;
  if (first === undefined) return { ...UNKNOWN, command: '(unknown)' };
  if (!canonical) {
    return { ...manual('flags before the subcommand: gh may read them as the command itself, so only a human runs this'), command: `${first} (unreadable)` };
  }
  const aliased = COMMAND_ALIASES[first];
  const groupName = aliased ? aliased[0] : (GROUP_ALIASES[first] ?? first);
  const sub = aliased ? aliased[1] : second;

  if (groupName === 'api') return { ...classifyApi(argv.slice(1)), command: 'api' };

  const group = GROUPS[groupName];
  if (!group) return { ...UNKNOWN, command: `${first} (unknown)` };
  const command = sub ? `${groupName} ${sub}` : groupName;
  if (sub !== undefined && group.reads.includes(sub)) return { ...refine(groupName, sub, argv, READ), command };
  const row = refine(groupName, sub ?? '', argv, (sub !== undefined ? group.rows?.[sub] : undefined) ?? group.other ?? UNKNOWN);
  // A click runs exactly what the reviewer read. A clustered or attached short flag (`-dF x`,
  // `-tTitle`) is a spelling this table does not take apart, so it cannot vouch for what gh will
  // do with it - written out in full, the same command would be promotable.
  if (row.promotable === 'click' && argv.some(isShortCluster)) {
    return { ...manual(`${row.reason}, but with combined or attached short flags: only a human runs it`), command };
  }
  return { ...row, command };
}

/** The `owner/repo` an explicit `-R/--repo` names, for display. */
export function ghTargetRepo(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if ((token === '-R' || token === '--repo') && argv[i + 1] !== undefined) return argv[i + 1];
    if (token.startsWith('--repo=')) return token.slice('--repo='.length);
  }
  return undefined;
}

/**
 * Flags whose value names a FILE the command reads (`--body-file x.md`, `-F x.md`), per group.
 * `-F` means `--body-file` for pr/issue writes but `--field` under `gh api`, which is why this is
 * keyed by group and never global. `-` means stdin, which the shim captures the same way.
 */
const FILE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  pr: ['--body-file', '-F'],
  issue: ['--body-file', '-F'],
  release: ['--notes-file', '-F'],
};

export interface FileReference {
  /** Index in argv of the token that carries the path, so a promotion can swap in the copy. */
  index: number;
  flag: string;
  value: string;
  /** `--body-file=x.md`: the path is inside the flag token itself rather than the next one. */
  inline: boolean;
}

/**
 * Only canonical spellings are found here (`-F x`, `--body-file x`, `--body-file=x`). A body file
 * hidden in a cluster (`-dF x`) is not, and does not need to be: `classifyGh` makes any such
 * command manual-only, so nothing unreviewed is ever promoted from it.
 */
export function ghFileReferences(argv: readonly string[]): FileReference[] {
  const { words } = parseCommand(argv);
  const first = words[0];
  const flags = first ? FILE_FLAGS[GROUP_ALIASES[first] ?? first] : undefined;
  if (!flags) return [];
  const refs: FileReference[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (flags.includes(token) && argv[i + 1] !== undefined) {
      refs.push({ index: i + 1, flag: token, value: argv[i + 1] as string, inline: false });
      i += 1;
      continue;
    }
    const long = flags.find((f) => f.startsWith('--') && token.startsWith(`${f}=`));
    if (long) refs.push({ index: i, flag: long, value: token.slice(long.length + 1), inline: true });
  }
  return refs;
}
