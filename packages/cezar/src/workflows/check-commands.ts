/**
 * Which commands ARE "the repository's checks" — the policy half of the landing
 * check, and the only place in the engine that reads a command list.
 *
 * The seam that EXECUTES a command (`check-runner.ts`, PR 2) deliberately knows
 * nothing about where a command came from. This module is the other half: it
 * answers "may anything run, and exactly what, with which bodies?" — and it
 * answers from the FROZEN BASE tree, never from the branch under test.
 *
 * Why base-pinned: a landing check runs a merge combination nobody reviewed as a
 * whole. If the candidate could pick the command list, a branch would decide what
 * verifies it (`"validation": {"commands": ["true"]}`), and if it could move the
 * body of a script the list names (`"test": "exit 0"`), pinning the list alone
 * would not help. So: the list and the resolved script bodies come from
 * `git show <baseSha>:…`; anything that differs between base and candidate is
 * visible as a drift verdict instead of a silently different gate.
 *
 * The iron rule of this module: **it executes nothing**. The only subprocesses it
 * ever spawns are fixed-argv `git` READS — `rev-parse` (one probe, to tell "no
 * such tree" from "this base is not readable"), `show <sha>:<path>` (the
 * frozen-base read), and `ls-tree` (one whole-tree listing, reached only when a
 * `-w` delegation makes the root `workspaces` globs matter) — no shell, and never
 * a string from either tree as a command. A caller (PR 4's core) hands `commands`
 * to `runCheckCommand`; a `nothing-to-check` or `could-not-run` resolution never
 * yields a command to run at all.
 *
 * Vocabulary (the spec's, `## Acceptance Criteria for PRs 2–6`, PR 3):
 *  - `resolved`             — a non-empty list, identical in base and candidate;
 *  - `nothing-to-check`     — `no-commands` (no source declares anything) or
 *                             `commands-changed-vs-base` (drift; `diff` says how);
 *  - `could-not-run`        — a source was present but unusable. Never a silent
 *                             fallback to a lower-precedence source.
 * `nothing-to-check` is not green and `commands` is empty on every non-`resolved`
 * status, so a caller that ignores `status` still has nothing to execute.
 *
 * What the pinned plan covers — the F1 lesson, extended by PR 3.2. Pinning the
 * bodies a list *directly* names is close to vacuous in a repo whose gate is a
 * set of thin delegating stubs (`typecheck` -> `npm run typecheck:server` ->
 * `-w @scope/pkg` -> the workspace's body), so the digest covers the TRANSITIVE
 * CLOSURE of npm-run references (bounded depth, cycle-safe, `pre*`/`post*` hooks
 * included), the local script files an argv names (best effort: an argv-position
 * token that exists in the tree), the Makefile when a make command makes it a
 * body, and — PR 3.2 — the WORKSPACE MANIFESTS a `-w`/`--workspace`/`--workspaces`
 * delegation addresses: resolved through the root `workspaces` globs, read from
 * the same tree, pinned recursively with the manifest path recorded. What cannot
 * be resolved statically — `npm run "$TARGET"`, a chain past the depth bound, a
 * delegation whose target the tree does not declare — is recorded in `notes`,
 * never guessed at.
 *
 * And what "cannot be read" means — the F3 lesson. `git show` exits 128 when the
 * path is not in that tree; that is absence. Every other failure (ENOBUFS on a
 * huge file, EACCES, a missing git) is a read that did not happen, and a read
 * that did not happen is `could-not-run` — never a silent "absent".
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The repo-level gate declaration every om-* skill already reads. Highest-precedence repo source. */
export const AGENTIC_CONFIG_PATH = '.ai/agentic.config.json';
/** The manifest discovery reads; also the source of npm script bodies for any list. */
export const PACKAGE_JSON_PATH = 'package.json';
/** Presence (not contents) decides the install argv: `npm ci` vs `npm install`. */
export const PACKAGE_LOCK_PATH = 'package-lock.json';
/** Surfaced, never run, never a discovery source. */
export const MAKEFILE_PATH = 'Makefile';

/**
 * The well-known npm script names discovery promotes, CHEAP-FIRST: static checks
 * (lint, typecheck) before the test suite before the build. The engine never
 * reorders a declared list — a source's order is authoritative, and
 * stop-at-first-failure is what makes cheap-first pay — so this ordering
 * heuristic exists only for the zero-config discovery path (source 3).
 */
const DISCOVERY_SCRIPT_NAMES = ['lint', 'typecheck', 'test', 'build'] as const;

/**
 * npm's own lifecycle scripts the root package runs during `npm ci` /
 * `npm install`, in npm 11's execution order. Their bodies execute as part of
 * the install step, so they are pinned with the list whenever an install step
 * exists. `prepublish` is deprecated but still RUN by npm 11 (verified against
 * npm 11.19.0: all seven run), so it is pinned like the rest.
 */
const INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'] as const;

/** How many npm-run hops the closure follows before the rest is recorded, not pinned. */
const MAX_SCRIPT_DEPTH = 8;

/** Cap on the text pinned for a local script file an argv names; larger files are recorded, not pinned. */
const MAX_PINNED_FILE_CHARS = 2 * 1024 * 1024;

/**
 * `git`'s stdout cap. A Makefile a make command pins is read through `git show`,
 * and this buffer is what stands between "present" and a silent "absent": the
 * reviewer proved a ~19 MB Makefile read as absent under the old 16 MiB cap.
 * Overflowing THIS cap is `could-not-run` (see `createFrozenBase`), never
 * absence — 64 MiB is comfortably past anything a repo keeps in-tree.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Extensions that make a bare argv token worth probing as a local script file. */
const SCRIPT_FILE_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ksh', '.mjs', '.cjs', '.js', '.ts', '.py', '.rb', '.pl', '.ps1'];

/** Interpreters whose first non-flag argument is itself the script to pin. */
const SCRIPT_INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'node', 'tsx', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl', 'pwsh', 'powershell']);

/** Wrappers that precede the real program in a simple command. */
const SEGMENT_WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo']);

/** npm script names are plain identifiers; anything else (`$VAR`, `$(…)`) is dynamic and recorded, not guessed. */
const PLAUSIBLE_SCRIPT_NAME = /^[A-Za-z0-9_:.+-][A-Za-z0-9_:.@+-]*$/;

/**
 * The digest payload's shape version. v1 pinned only the bodies a list directly
 * named; v2 added the transitive npm-run closure and the argv script files; v3
 * (PR 3.2) adds the workspace manifests behind `-w`/`--workspace`/`--workspaces`
 * delegations. A payload change means a version bump — the digest is compared
 * across runs, never persisted, but PR 4 and the review read this number.
 */
export const CHECK_PLAN_DIGEST_VERSION = 3;

/** How much of a drift diff is kept. A moved body is the interesting part, and a
 *  manifest diff cannot usefully exceed this. */
export const CHECK_DIFF_CAP = 20_000;

export type CheckCommandSource = 'explicit' | 'agentic-config' | 'package-json' | 'none';

export type CheckCommandReason =
  | 'no-commands'
  | 'commands-changed-vs-base'
  | 'malformed-agentic-config'
  | 'malformed-package-json'
  | 'unreadable-base'
  /** A file is in the tree but the read failed (ENOBUFS/EACCES/…) — not the same as absent. */
  | 'unreadable-source';

export type CheckCommandStatus = 'resolved' | 'nothing-to-check' | 'could-not-run';

export type InstallKind = 'ci' | 'install' | 'none';

/** One command of the pinned plan, with the body the frozen base resolves it to. */
export interface ResolvedCheckCommand {
  /** The winning source — where this command's ARGV came from. */
  source: CheckCommandSource;
  /** The normalized command line, e.g. `npm run build`. */
  command: string;
  /**
   * Present when the command addresses an npm script the frozen base defines
   * (`npm test` → `test`, `npm run x …` → `x`): the name and the base's body.
   * Absent for anything else (`./scripts/gate.sh`, `make test`) — those are
   * pinned by their argv only.
   */
  script?: { name: string; body: string };
}

/** The install step's argv, resolved from the frozen base's manifest presence. */
export interface CheckInstallPlan {
  kind: InstallKind;
  /** `['npm', 'ci']`, `['npm', 'install']`, or `[]` — spawned without a shell. */
  argv: string[];
  /** Why this argv, naming the frozen-base file that decided it. */
  because: string;
}

export interface CheckCommandResolution {
  status: CheckCommandStatus;
  /** Set for every non-`resolved` status; undefined when the plan is runnable. */
  reason?: CheckCommandReason;
  /**
   * The FROZEN BASE's winning source — the source of the plan that would run.
   * `none` when the base pinned nothing (the notes name what the candidate has).
   */
  source: CheckCommandSource;
  /** Empty unless `status === 'resolved'`. A non-resolved resolution has nothing to run. */
  commands: ResolvedCheckCommand[];
  /** `sha256:…` over the list, the resolved bodies and (when pinned) the Makefile. */
  digest: string;
  changedVsBase: boolean;
  /** Unified-ish diff of the pinned plan vs the candidate's; `''` when nothing differs. */
  diff: string;
  /** One line per source consulted, plus the outcome — the `no-commands` explanation lives here. */
  notes: string[];
  /** Targets surfaced from the frozen base's Makefile. Shown as text; never run. */
  makefile: { present: boolean; targets: string[] };
  install: CheckInstallPlan;
}

export interface ResolveCheckCommandsOptions {
  /** The frozen base commit (the invoking run's branch tip, frozen before any merge). */
  baseSha: string;
  /** The request/CLI command list. Highest precedence; replaces the repo sources. */
  explicit?: readonly string[];
  /** The candidate tree (the landing check's scratch worktree). Read, never executed. */
  repoRoot: string;
}

/** A file as found in one tree: present, absent, or present-but-unreadable. */
type TreeFile =
  | { kind: 'file'; text: string }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

interface ScriptBody {
  name: string;
  body: string;
}

/** A local script file an argv names, pinned by its text. */
interface PinnedFile {
  path: string;
  text: string;
}

/** One workspace manifest the root `workspaces` globs name. */
interface WorkspaceManifest {
  /** Tree-relative manifest path, e.g. `packages/cezar/package.json`. */
  path: string;
  /** The manifest's `name`, when it declares a string one — what `-w <name>` addresses. */
  name?: string;
  scripts: Record<string, string>;
}

/** A workspace script body, pinned with the manifest that defines it. */
interface WorkspaceScriptBody {
  manifest: string;
  name: string;
  body: string;
}

/** The workspace manifests one lookup resolved, or why it resolved none. */
interface WorkspaceLookup {
  manifests: WorkspaceManifest[];
  /** Glob-matched manifests present but unreadable/unusable — a read that did not happen. */
  errors: string[];
  /** Why no manifest was resolved; `undefined` when the lookup is complete. */
  detail?: string;
}

/**
 * Resolve the root `"workspaces"` globs once, then answer `-w` selectors against
 * them. Built lazily: a plan with no delegation never lists a tree.
 */
interface WorkspaceIndex {
  /** Every workspace manifest this tree declares — what `-ws`/`--workspaces` addresses. */
  all(): WorkspaceLookup;
  /** The manifests a `-w <name|path>` selector names. */
  matching(selector: string): WorkspaceLookup;
}

/** Every path in one tree, or why the listing could not be read. */
type TreePathListing = { kind: 'paths'; paths: string[] } | { kind: 'error'; message: string };

/** Everything one tree resolves to; base and candidate are built the same way. */
interface TreePlan {
  label: string;
  source: CheckCommandSource;
  commands: string[];
  /** The npm-run closure: referenced scripts, their hooks, the hooks of the chain, sorted by name. */
  scripts: ScriptBody[];
  /** Workspace script bodies reached through `-w` delegations, sorted by manifest then name. */
  workspaceScripts: WorkspaceScriptBody[];
  /** Local script files named in argv, sorted by path. */
  files: PinnedFile[];
  makefile: { present: boolean; targets: string[]; text: string; pinned: boolean };
  install: { kind: InstallKind; argv: string[]; file?: string; error?: string };
  /** The tree's consulted source is present but unusable — the plan stops there. */
  malformed?: { reason: CheckCommandReason; detail: string };
  notes: string[];
  /** The workspace manifest paths this tree resolved; the candidate reads exactly these. */
  workspaceManifestPaths: string[];
}

interface FrozenBase {
  shortSha: string;
  read(path: string): TreeFile;
  /** Every path in the base tree — one `git ls-tree`, cached; resolves `workspaces` globs. */
  listPaths(): TreePathListing;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** What one fixed-argv `git` read returned: ok, or why it failed. */
interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The child's exit status; `null` when it never exited (spawn failure, buffer overflow). */
  status: number | null;
  /** Node's error code (`ENOBUFS`, `EACCES`, …), when there is one. */
  code?: string;
}

/** `git`, no shell, never throws — degradation is the caller's policy. */
function git(cwd: string, args: string[]): GitRun {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });
    return { ok: true, stdout, stderr: '', status: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string; status?: number | null; code?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: (failure.stderr ?? failure.message ?? 'git failed').trim(),
      status: typeof failure.status === 'number' ? failure.status : null,
      ...(failure.code ? { code: failure.code } : {}),
    };
  }
}

/** Why a read failed, as the notes and details report it. */
function readFailureReason(run: GitRun): string {
  if (run.code) return run.stderr ? `${run.code}: ${run.stderr}` : run.code;
  if (run.status !== null) return `exit ${run.status}${run.stderr ? `: ${run.stderr}` : ''}`;
  return run.stderr || 'git failed';
}

/**
 * Open the frozen base for reading. One probe decides whether the base is
 * readable at all: `git cat-file -e` cannot separate "no such path" from "no
 * such object" (both exit 128), so the probe is `rev-parse --verify --quiet`.
 * After it, `git show` exit 128 means exactly one thing — the path is absent
 * from that tree. Every OTHER failure (ENOBUFS on a huge file, EACCES, a git
 * that cannot spawn) is a read that did not happen: it yields `error`, which
 * the plan treats as `could-not-run`, never as absence. Never throws; an
 * unreadable base is a value.
 */
function createFrozenBase(repoRoot: string, baseSha: string): { kind: 'ok'; base: FrozenBase } | { kind: 'error'; detail: string } {
  const probe = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`]);
  if (!probe.ok) {
    return { kind: 'error', detail: `git rev-parse ${shortSha(baseSha)}^{commit} failed: ${probe.stderr || 'git is not available'}` };
  }
  const cache = new Map<string, TreeFile>();
  let listing: TreePathListing | undefined;
  return {
    kind: 'ok',
    base: {
      shortSha: shortSha(baseSha),
      read(path: string): TreeFile {
        const cached = cache.get(path);
        if (cached) return cached;
        // A FIXED argv: the only tree-supplied part is the path constant above.
        const show = git(repoRoot, ['show', `${baseSha}:${path}`]);
        const result: TreeFile = show.ok
          ? { kind: 'file', text: show.stdout }
          : show.status === 128
            ? { kind: 'absent' }
            : { kind: 'error', message: `git show ${shortSha(baseSha)}:${path} could not be read (${readFailureReason(show)}) — present but unreadable, not absent` };
        cache.set(path, result);
        return result;
      },
      listPaths(): TreePathListing {
        if (listing) return listing;
        // A FIXED argv: the whole tree, so nothing tree-supplied (a `workspaces`
        // glob, a path) reaches git as a pathspec.
        const ls = git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', baseSha]);
        listing = ls.ok
          ? { kind: 'paths', paths: ls.stdout.split('\0').filter((path) => path !== '') }
          : { kind: 'error', message: `git ls-tree ${shortSha(baseSha)} could not be read (${readFailureReason(ls)})` };
        return listing;
      },
    },
  };
}

function readWorkingFile(repoRoot: string, path: string): TreeFile {
  try {
    return { kind: 'file', text: readFileSync(join(repoRoot, path), 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'EISDIR' ? { kind: 'absent' } : { kind: 'error', message: (err as Error).message };
  }
}

/**
 * Trim, collapse whitespace OUTSIDE quotes, drop blanks and exact duplicates,
 * keep first-occurrence order. Quote-aware because collapsing inside `"…"`
 * would change an argument (`--grep "a  b"`).
 */
export function normalizeCommands(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const command = normalizeCommand(raw);
    if (!command || out.includes(command)) continue;
    out.push(command);
  }
  return out;
}

function normalizeCommand(raw: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  let pendingSpace = false;
  for (const ch of raw.trim()) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      pendingSpace = out.length > 0;
      continue;
    }
    // Flush the run of whitespace BEFORE this character, whatever it is — the
    // space in `--grep "a  b"` belongs in front of the opening quote.
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/**
 * The npm script a command addresses, if any: `npm test` (npm's one documented
 * alias for `npm run test`) and `npm run [--] <name>`. `npm ci` / `npm install`
 * are npm's own verbs, not scripts, and are deliberately NOT resolved to a body.
 */
export function npmScriptName(command: string): string | undefined {
  const trimmed = command.trim();
  if (/^npm\s+test(\s|$)/.test(trimmed)) return 'test';
  const match = /^npm\s+(?:run|run-script)\s+([^\s-][^\s]*)/.exec(trimmed);
  return match?.[1];
}

/** Does the list invoke `make`? A make target's body lives in the Makefile, so its text is pinned too. */
export function commandInvokesMake(command: string): boolean {
  return /^make(\s|$)/.test(command.trim());
}

/** Strip one matching pair of surrounding quotes. */
function unquote(token: string): string {
  const first = token[0];
  if (token.length >= 2 && (first === '"' || first === "'") && token[token.length - 1] === first) return token.slice(1, -1);
  return token;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Split a command line into shell "simple command" segments. Unquoted `;&|<>()`
 * and newlines end a segment, whitespace separates tokens, quotes group. This is
 * deliberately small — it exists to find script references, never to execute.
 */
function shellSegments(text: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  const endToken = (): void => {
    if (token) {
      tokens.push(token);
      token = '';
    }
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length) {
      segments.push(tokens);
      tokens = [];
    }
  };
  for (const ch of text) {
    if (quote) {
      token += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      token += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endToken();
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      endSegment();
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')' || ch === '<' || ch === '>') {
      endSegment();
      continue;
    }
    token += ch;
  }
  endSegment();
  return segments;
}

/** One `-w`/`--workspace`/`--workspaces` delegation: a script npm runs in another manifest. */
interface WorkspaceDelegation {
  /** The script name npm resolves in the target manifest(s). */
  script: string;
  /** The `-w <name|path>` selector; absent for `-ws`/`--workspaces` (every workspace). */
  workspace?: string;
}

interface NpmScriptRefs {
  /** Scripts npm resolves against the SAME manifest (no workspace flag in the segment). */
  names: string[];
  /** References whose target cannot be resolved statically, verbatim. */
  dynamic: string[];
  /** Scripts the segment delegates to other workspaces — where they actually run. */
  delegations: WorkspaceDelegation[];
}

/**
 * One npm workspace flag, with the token index to resume at. `-w x`,
 * `--workspace x`, `--workspace=x` and `-w=x` name one workspace; `-ws` /
 * `--workspaces` names every workspace. A workspace flag whose value is missing
 * is not a flag (it is left for the ordinary flag-skipping).
 */
function parseWorkspaceFlag(tokens: readonly string[], index: number): { delegation: Omit<WorkspaceDelegation, 'script'>; next: number } | undefined {
  const token = unquote(tokens[index] ?? '');
  if (token === '-ws' || token === '--workspaces') return { delegation: {}, next: index + 1 };
  const match = /^(?:-w|--workspace)(?:=(.+))?$/.exec(token);
  if (!match) return undefined;
  const inline = match[1];
  if (inline !== undefined) return inline === '' ? undefined : { delegation: { workspace: inline }, next: index + 1 };
  const value = tokens[index + 1] === undefined ? undefined : unquote(tokens[index + 1]!);
  if (value === undefined || value.startsWith('-')) return undefined;
  return { delegation: { workspace: value }, next: index + 2 };
}

/**
 * Every npm script a piece of shell text references, ANYWHERE in it: the head of
 * a simple command (`npm test`), the tail of a compound one (`a && npm run b`),
 * and every hop of a script body. A name that is not a plain identifier
 * (`npm run "$TARGET"`) is reported as dynamic instead of guessed at. A workspace
 * flag changes WHERE the script resolves (`npm run build -w @scope/pkg` runs the
 * workspace's `build`, not the root's), so such a segment yields a delegation and
 * never a same-manifest name.
 */
function extractNpmScriptRefs(text: string): NpmScriptRefs {
  const names: string[] = [];
  const dynamic: string[] = [];
  const delegations: WorkspaceDelegation[] = [];
  for (const tokens of shellSegments(text)) {
    for (let i = 0; i < tokens.length; i += 1) {
      if (unquote(tokens[i] ?? '') !== 'npm') continue;
      // Only workspace flags may precede the verb; any other leading token keeps
      // the original parse (it must be the verb itself).
      const targets: Omit<WorkspaceDelegation, 'script'>[] = [];
      let cursor = i + 1;
      while (cursor < tokens.length) {
        const flag = parseWorkspaceFlag(tokens, cursor);
        if (!flag) break;
        targets.push(flag.delegation);
        cursor = flag.next;
      }
      const verb = tokens[cursor] === undefined ? undefined : unquote(tokens[cursor]!);
      let after = cursor + 1;
      let script: string | undefined;
      if (verb === 'test') {
        script = 'test';
      } else if (verb === 'run' || verb === 'run-script') {
        while (after < tokens.length) {
          const flag = parseWorkspaceFlag(tokens, after);
          if (flag) {
            targets.push(flag.delegation);
            after = flag.next;
            continue;
          }
          if (unquote(tokens[after]!).startsWith('-')) {
            after += 1;
            continue;
          }
          script = unquote(tokens[after]!);
          after += 1;
          break;
        }
        if (script === undefined) continue;
      } else {
        continue;
      }
      // Workspace flags may also follow the script name.
      for (let k = after; k < tokens.length; k += 1) {
        const flag = parseWorkspaceFlag(tokens, k);
        if (!flag) continue;
        targets.push(flag.delegation);
        if (flag.next > k + 1) k = flag.next - 1;
      }
      if (!PLAUSIBLE_SCRIPT_NAME.test(script)) {
        dynamic.push(`npm ${verb} ${script}`);
      } else if (targets.length) {
        for (const target of targets) delegations.push({ ...target, script });
      } else {
        names.push(script);
      }
      i = after - 1;
    }
  }
  const seen = new Set<string>();
  const uniqueDelegations = delegations.filter((delegation) => {
    const key = `${delegation.workspace ?? '*'}\u0000${delegation.script}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { names: dedupe(names), dynamic: dedupe(dynamic), delegations: uniqueDelegations };
}

/** The local script path a bare argv token names, if it looks like one. */
function localScriptPath(token: string): string | undefined {
  const raw = unquote(token.trim());
  if (!raw || raw.startsWith('-') || raw.startsWith('/') || raw.startsWith('~')) return undefined;
  if (/[$`*?{}[\]<>|;&()!'"]/.test(raw)) return undefined;
  const path = raw.replace(/^\.\//, '');
  if (!path || path.split('/').includes('..')) return undefined;
  if (!SCRIPT_FILE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) return undefined;
  return path;
}

/**
 * Local script files a command names in argv: the program position of a simple
 * command (`./scripts/gate.sh`), or the first non-flag argument of an
 * interpreter (`sh .ai/scripts/e2e.sh`). Best effort by design — a token that
 * does not exist in the tree is simply not pinned, and a data argument
 * (`vitest run src/x.test.ts`) is never a candidate because it sits after a
 * non-interpreter program.
 */
function scriptFilePaths(commands: readonly string[]): string[] {
  const out: string[] = [];
  for (const command of commands) {
    for (const tokens of shellSegments(command)) {
      let head = 0;
      while (head < tokens.length) {
        const token = unquote(tokens[head]!);
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || SEGMENT_WRAPPERS.has(token)) {
          head += 1;
          continue;
        }
        break;
      }
      const program = tokens[head] === undefined ? undefined : unquote(tokens[head]!);
      if (program === undefined) continue;
      const candidates = [program];
      if (SCRIPT_INTERPRETERS.has(program)) {
        for (let i = head + 1; i < tokens.length; i += 1) {
          const token = unquote(tokens[i]!);
          if (token.startsWith('-')) continue;
          candidates.push(token);
          break;
        }
      }
      for (const candidate of candidates) {
        const path = localScriptPath(candidate);
        if (path) out.push(path);
      }
    }
  }
  return dedupe(out);
}

/** `packages/cezar` from `packages/cezar/package.json` — what a `-w <path>` selector names. */
function manifestDirectory(manifestPath: string): string {
  return dirname(manifestPath).replace(/^\.$/, '');
}

/** Strip `./` and trailing slashes from a workspace glob or a `-w <path>` selector. */
function normalizeWorkspacePath(value: string): string {
  return value.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** npm workspace globs are simple: `?`/`*` stay inside one segment, `**` crosses. */
function workspaceGlobToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 1;
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`);
}

/**
 * The manifest paths the root `"workspaces"` globs name, from a flat path
 * listing. npm globs address DIRECTORIES, so each is matched as
 * `<glob>/package.json`; a `!`-prefixed glob excludes (npm's negation).
 */
function workspaceManifestPaths(allPaths: readonly string[], globs: readonly string[]): string[] {
  const included: string[] = [];
  const excluded = new Set<string>();
  for (const raw of globs) {
    const negated = raw.trim().startsWith('!');
    const pattern = normalizeWorkspacePath(negated ? raw.trim().slice(1) : raw);
    if (!pattern) continue;
    const regex = workspaceGlobToRegExp(`${pattern}/package.json`);
    for (const path of allPaths) {
      if (!regex.test(path)) continue;
      if (negated) excluded.add(path);
      else included.push(path);
    }
  }
  return dedupe(included.filter((path) => !excluded.has(path))).sort();
}

/**
 * Read every workspace manifest of one tree. The BASE resolves its manifest set
 * from the root `"workspaces"` globs (list the tree with `git ls-tree`, match,
 * `git show` each manifest); the CANDIDATE reads the FROZEN BASE's manifest paths
 * from the working tree — the plan that would run is the base's, and reading the
 * same files is what turns a neutered workspace script into a drift line. Built
 * lazily: a plan with no `-w` delegation never lists a tree.
 */
function createWorkspaceIndex(sources: TreeSources, manifest: ParsedManifest): WorkspaceIndex {
  let cached: WorkspaceLookup | undefined;
  const all = (): WorkspaceLookup => (cached ??= resolveAll());
  const resolveAll = (): WorkspaceLookup => {
    let paths: string[];
    if (sources.workspaceManifestPaths) {
      paths = [...sources.workspaceManifestPaths];
      if (paths.length === 0) return { manifests: [], errors: [], detail: `the frozen base resolved no workspace manifest under ${PACKAGE_JSON_PATH}` };
    } else {
      if (manifest.workspaces === undefined) {
        return { manifests: [], errors: [], detail: manifest.workspacesDetail ?? `no "workspaces" field in ${PACKAGE_JSON_PATH}` };
      }
      if (manifest.workspaces.length === 0) return { manifests: [], errors: [], detail: `"workspaces" in ${PACKAGE_JSON_PATH} is empty` };
      const listing = sources.listPaths?.();
      if (!listing || listing.kind === 'error') {
        const message = listing?.kind === 'error' ? listing.message : 'this tree cannot be listed';
        return { manifests: [], errors: [`${PACKAGE_JSON_PATH}: workspaces could not be listed (${message})`], detail: `the tree could not be listed (${message})` };
      }
      paths = workspaceManifestPaths(listing.paths, manifest.workspaces);
      if (paths.length === 0) return { manifests: [], errors: [], detail: `"workspaces" (${manifest.workspaces.join(', ')}) matches no manifest` };
    }
    const manifests: WorkspaceManifest[] = [];
    const errors: string[] = [];
    for (const path of paths) {
      const file = sources.read(path);
      if (file.kind === 'absent') continue;
      if (file.kind === 'error') {
        errors.push(`${path}: ${file.message}`);
        continue;
      }
      const parsed = parseWorkspaceManifest(file, path);
      if (!parsed.ok) {
        errors.push(parsed.detail ?? `${path}: unusable`);
        continue;
      }
      manifests.push(parsed.value!);
    }
    return {
      manifests,
      errors,
      ...(manifests.length === 0 ? { detail: `none of the ${paths.length} workspace manifest(s) ${PACKAGE_JSON_PATH} declares could be read` } : {}),
    };
  };
  return {
    all,
    matching(selector: string): WorkspaceLookup {
      const lookup = all();
      const wanted = normalizeWorkspacePath(selector);
      const matches = lookup.manifests.filter(
        (entry) => entry.name === selector || normalizeWorkspacePath(entry.path) === wanted || manifestDirectory(entry.path) === wanted,
      );
      if (matches.length) return { ...lookup, manifests: matches };
      return { ...lookup, manifests: [], detail: `no workspace manifest named or at "${selector}"` };
    },
  };
}

interface ClosureInput {
  /** The root manifest's scripts. */
  rootScripts: Record<string, string>;
  commandRoots: readonly string[];
  lifecycleRoots: readonly string[];
  filePaths: readonly string[];
  readFile: (path: string) => TreeFile;
  workspaces: WorkspaceIndex;
  notes: string[];
}

interface ClosureResult {
  scripts: ScriptBody[];
  workspaceScripts: WorkspaceScriptBody[];
  files: PinnedFile[];
  errors: string[];
  /** The workspace manifest paths any delegation resolved — the candidate reads exactly these. */
  workspaceManifestPaths: string[];
}

/** One node of the closure: an npm script body (root or workspace manifest), or a local script file named in argv. */
type ClosureNode =
  | { kind: 'script'; manifest: string; name: string; depth: number }
  | { kind: 'file'; path: string; depth: number };

/**
 * The bodies the plan would execute: the transitive npm-run closure of the list
 * plus the local script files its argv names, plus (when an install step exists)
 * npm's install lifecycle hooks and everything THEY reach. Each body contributes
 * its `pre*`/`post*` hooks and every npm script it references, to a bounded
 * depth; `seen` makes a cycle terminate, and a node is pinned once, at the
 * shallowest depth it is reached (the queue is FIFO). A `-w` delegation moves
 * the same closure into another manifest (`workspaces`), so a workspace script
 * is pinned like any other body — keyed by manifest, hooks and all — and a body
 * that cannot be resolved statically is recorded in `notes`, so the verdict can
 * state what is NOT pinned.
 */
function collectPinnedBodies(input: ClosureInput): ClosureResult {
  const { rootScripts, commandRoots, lifecycleRoots, filePaths, readFile, workspaces, notes } = input;
  const scriptsByManifest = new Map<string, Record<string, string>>([[PACKAGE_JSON_PATH, rootScripts]]);
  const bodies = new Map<string, WorkspaceScriptBody>();
  const files = new Map<string, string>();
  const workspaceManifestPathsSeen = new Set<string>();
  const seenScripts = new Set<string>();
  const seenFiles = new Set<string>();
  const errors: string[] = [];
  const queue: ClosureNode[] = [];
  const note = (line: string): void => {
    if (!notes.includes(line)) notes.push(line);
  };
  const fail = (line: string): void => {
    if (!errors.includes(line)) errors.push(line);
  };
  const scriptKey = (manifest: string, name: string): string => `${manifest}\u0000${name}`;

  const visitScript = (manifest: string, name: string, depth: number): boolean => {
    const scripts = scriptsByManifest.get(manifest);
    if (!scripts || scripts[name] === undefined) return false;
    const key = scriptKey(manifest, name);
    if (!seenScripts.has(key)) {
      seenScripts.add(key);
      queue.push({ kind: 'script', manifest, name, depth });
    }
    return true;
  };
  const visitFile = (path: string, depth: number): void => {
    if (seenFiles.has(path)) return;
    seenFiles.add(path);
    queue.push({ kind: 'file', path, depth });
  };

  const followWorkspace = (origin: string, delegation: WorkspaceDelegation, depth: number): void => {
    const lookup = delegation.workspace === undefined ? workspaces.all() : workspaces.matching(delegation.workspace);
    for (const error of lookup.errors) fail(error);
    for (const manifest of lookup.manifests) {
      workspaceManifestPathsSeen.add(manifest.path);
      scriptsByManifest.set(manifest.path, manifest.scripts);
    }
    const label = delegation.workspace === undefined ? 'npm --workspaces' : `npm workspace "${delegation.workspace}"`;
    const targets = lookup.manifests.filter((manifest) => manifest.scripts[delegation.script] !== undefined);
    if (targets.length === 0) {
      const why =
        lookup.detail ??
        (lookup.manifests.length
          ? `none of ${lookup.manifests.map((manifest) => manifest.path).join(', ')} defines it`
          : 'the tree declares no workspace manifest for it');
      note(`${origin}: ${label} could not be pinned (${why}) — the delegated "${delegation.script}" script body is not pinned`);
      return;
    }
    note(`${origin}: ${label} → ${targets.map((manifest) => manifest.path).join(', ')} — the delegated "${delegation.script}" script is pinned`);
    for (const manifest of targets) visitScript(manifest.path, delegation.script, depth);
  };

  const follow = (origin: string, text: string, manifest: string, depth: number): void => {
    const scripts = scriptsByManifest.get(manifest) ?? {};
    const refs = extractNpmScriptRefs(text);
    for (const ref of refs.names) {
      if (scripts[ref] === undefined) {
        note(`${origin}: references npm script "${ref}", which the frozen base does not define — its body is not pinned`);
        continue;
      }
      if (depth >= MAX_SCRIPT_DEPTH) {
        note(`${origin}: the npm-run chain is deeper than ${MAX_SCRIPT_DEPTH} hops at "${ref}" — its body is not pinned (bounded depth)`);
        continue;
      }
      visitScript(manifest, ref, depth + 1);
    }
    for (const dynamic of refs.dynamic) note(`${origin}: dynamic npm-run reference (${dynamic}) — not pinnable, and not pinned`);
    for (const delegation of refs.delegations) {
      if (depth >= MAX_SCRIPT_DEPTH) {
        note(`${origin}: the npm-run chain is deeper than ${MAX_SCRIPT_DEPTH} hops at the "${delegation.script}" workspace delegation — its body is not pinned (bounded depth)`);
        continue;
      }
      followWorkspace(origin, delegation, depth + 1);
    }
  };

  for (const name of lifecycleRoots) visitScript(PACKAGE_JSON_PATH, name, 1);
  for (const path of filePaths) visitFile(path, 1);
  for (const command of commandRoots) {
    const refs = extractNpmScriptRefs(command);
    for (const name of refs.names) {
      if (!visitScript(PACKAGE_JSON_PATH, name, 1)) {
        notes.push(`${command}: the frozen base resolves no "${name}" script — the argv is pinned, its body is not`);
      }
    }
    for (const delegation of refs.delegations) followWorkspace(command, delegation, 1);
  }

  while (queue.length) {
    const node = queue.shift()!;
    if (node.kind === 'script') {
      const scripts = scriptsByManifest.get(node.manifest) ?? {};
      const body = scripts[node.name];
      if (body === undefined) continue;
      bodies.set(scriptKey(node.manifest, node.name), { manifest: node.manifest, name: node.name, body });
      for (const hook of [`pre${node.name}`, `post${node.name}`]) visitScript(node.manifest, hook, node.depth);
      follow(`script "${node.name}"`, body, node.manifest, node.depth);
      continue;
    }
    const file = readFile(node.path);
    if (file.kind === 'error') {
      errors.push(`${node.path}: ${file.message}`);
      continue;
    }
    if (file.kind === 'absent') continue;
    if (file.text.length > MAX_PINNED_FILE_CHARS) {
      note(`${node.path}: ${file.text.length} characters exceeds the ${MAX_PINNED_FILE_CHARS} character pin cap — its body is NOT pinned`);
      continue;
    }
    files.set(node.path, file.text);
    note(`${node.path}: pinned as a body named in argv (${file.text.length} characters)`);
    follow(`file "${node.path}"`, file.text, PACKAGE_JSON_PATH, node.depth);
  }

  const allBodies = [...bodies.values()];
  return {
    scripts: allBodies
      .filter((entry) => entry.manifest === PACKAGE_JSON_PATH)
      .map(({ name, body }) => ({ name, body }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    workspaceScripts: allBodies
      .filter((entry) => entry.manifest !== PACKAGE_JSON_PATH)
      .sort((a, b) =>
        a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
    files: [...files.entries()]
      .map(([path, text]) => ({ path, text }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    errors,
    workspaceManifestPaths: [...workspaceManifestPathsSeen].sort(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParseResult<T> {
  ok: boolean;
  value?: T;
  detail?: string;
}

/** The root manifest as this module reads it: script bodies plus the `workspaces` globs. */
interface ParsedManifest {
  scripts: Record<string, string>;
  /** The root `"workspaces"` globs (npm's array form, or yarn's `{ "packages": [...] }`). */
  workspaces?: string[];
  /** Present but unusable — a `-w` delegation cannot be resolved against it. */
  workspacesDetail?: string;
}

function parseManifest(file: TreeFile, label: string): ParseResult<ParsedManifest> {
  if (file.kind === 'absent') return { ok: true, value: { scripts: {} } };
  if (file.kind === 'error') return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}): ${file.message}` };
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (err) {
    return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}) is not valid JSON: ${(err as Error).message}` };
  }
  if (!isObject(raw)) return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}) is not a JSON object` };
  const workspaces = parseWorkspacesField(raw['workspaces']);
  const scripts = raw['scripts'];
  if (scripts === undefined) return { ok: true, value: { scripts: {}, ...workspaces } };
  if (!isObject(scripts)) return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}): "scripts" is not an object` };
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}): script "${name}" is not a string` };
    out[name] = body;
  }
  return { ok: true, value: { scripts: out, ...workspaces } };
}

/**
 * npm's `workspaces` field. A mismatched shape is reported, never silently
 * ignored — but it does not make the whole manifest malformed: without a `-w`
 * delegation the field is not consulted at all.
 */
function parseWorkspacesField(raw: unknown): Pick<ParsedManifest, 'workspaces' | 'workspacesDetail'> {
  if (raw === undefined) return {};
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw['packages']) ? (raw['packages'] as unknown[]) : undefined;
  if (list === undefined) return { workspacesDetail: `${PACKAGE_JSON_PATH}: "workspaces" is neither an array of globs nor { packages: [...] }` };
  const globs: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { workspacesDetail: `${PACKAGE_JSON_PATH}: "workspaces" entries must be non-empty strings (found ${JSON.stringify(entry)})` };
    }
    globs.push(entry.trim());
  }
  return { workspaces: globs };
}

/** One workspace manifest, as read from one tree. */
function parseWorkspaceManifest(file: TreeFile, path: string): ParseResult<WorkspaceManifest> {
  if (file.kind !== 'file') return { ok: false, detail: `${path}: not a readable file` };
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (err) {
    return { ok: false, detail: `${path}: not valid JSON: ${(err as Error).message}` };
  }
  if (!isObject(raw)) return { ok: false, detail: `${path}: not a JSON object` };
  const scripts: Record<string, string> = {};
  const scriptsRaw = raw['scripts'];
  if (scriptsRaw !== undefined) {
    if (!isObject(scriptsRaw)) return { ok: false, detail: `${path}: "scripts" is not an object` };
    for (const [name, body] of Object.entries(scriptsRaw)) {
      if (typeof body !== 'string') return { ok: false, detail: `${path}: script "${name}" is not a string` };
      scripts[name] = body;
    }
  }
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : undefined;
  return { ok: true, value: { path, ...(name === undefined ? {} : { name }), scripts } };
}

function parseAgenticConfig(file: TreeFile, label: string): ParseResult<string[]> {
  if (file.kind === 'absent') return { ok: true, value: [] };
  if (file.kind === 'error') return { ok: false, detail: `${AGENTIC_CONFIG_PATH} (${label}): ${file.message}` };
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (err) {
    return { ok: false, detail: `${AGENTIC_CONFIG_PATH} (${label}) is not valid JSON: ${(err as Error).message}` };
  }
  if (!isObject(raw)) return { ok: false, detail: `${AGENTIC_CONFIG_PATH} (${label}) is not a JSON object` };
  const validation = raw['validation'];
  if (validation === undefined) return { ok: true, value: [] };
  if (!isObject(validation)) return { ok: false, detail: `${AGENTIC_CONFIG_PATH} (${label}): "validation" is not an object` };
  const commands = validation['commands'];
  if (commands === undefined) return { ok: true, value: [] };
  if (!Array.isArray(commands)) return { ok: false, detail: `${AGENTIC_CONFIG_PATH} (${label}): "validation.commands" is not an array` };
  for (const entry of commands) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, detail: `${AGENTIC_CONFIG_PATH} (${label}): "validation.commands" entries must be non-empty strings (found ${JSON.stringify(entry)})` };
    }
  }
  return { ok: true, value: normalizeCommands(commands as string[]) };
}

/** Target extraction identical to `detectVerifyCommands` (`planner.ts`): the first
 *  50 lines, non-dot targets, at most 8 — so the surfaced preview matches what the
 *  planner would have suggested, while this module never runs any of them. */
function makefileTargets(text: string): string[] {
  const targets: string[] = [];
  for (const line of text.split('\n').slice(0, 50)) {
    const match = /^([A-Za-z0-9_.-]+):(?!=)/.exec(line);
    if (match?.[1] && !match[1].startsWith('.')) targets.push(match[1]);
    if (targets.length >= 8) break;
  }
  return targets;
}

interface TreeSources {
  label: string;
  explicit: readonly string[] | undefined;
  agenticConfig: TreeFile;
  packageJson: TreeFile;
  packageLock: TreeFile;
  makefile: TreeFile;
  /** Read another path from THIS tree — the local script files argv names, the workspace manifests. */
  read: (path: string) => TreeFile;
  /** List every path in THIS tree — the base only; resolves the `"workspaces"` globs. */
  listPaths?: () => TreePathListing;
  /** Set on the candidate: read workspace manifests at exactly these frozen-base paths. */
  workspaceManifestPaths?: readonly string[];
}

/**
 * Resolve ONE tree: the list, the bodies it needs, the install argv and the notes.
 * A present-but-unusable consulted source (malformed JSON, `commands` that is not
 * an array of strings, `scripts` that is not a string map) sets `malformed` and
 * yields no commands at all — never a silent fallback to a lower-precedence
 * source. The config is consulted only when no explicit list wins; the manifest
 * is read in every plan because bodies and the install argv come from it.
 */
function planFromSources(sources: TreeSources): TreePlan {
  const label = sources.label;
  const notes: string[] = [];

  // Supplied is a PRESENCE question, not a length one: an explicit `['']` is a
  // caller saying "run this list", and the list normalizes to nothing — it must
  // not fall through to the repo sources and quietly run the repo's gate.
  const explicitSupplied = sources.explicit !== undefined;
  const explicit = normalizeCommands(sources.explicit ?? []);
  const configConsulted = !explicitSupplied;
  const config = parseAgenticConfig(sources.agenticConfig, label);
  const manifest = parseManifest(sources.packageJson, label);

  let malformed: TreePlan['malformed'];
  if (configConsulted && !config.ok) {
    malformed = { reason: 'malformed-agentic-config', detail: config.detail ?? `${AGENTIC_CONFIG_PATH} (${label}) is unusable` };
  }
  if (!manifest.ok) {
    malformed ??= { reason: 'malformed-package-json', detail: manifest.detail ?? `${PACKAGE_JSON_PATH} (${label}) is unusable` };
  }

  // --- notes: every source, in precedence order, saying what it contributed.
  notes.push(
    !explicitSupplied
      ? 'explicit: not supplied'
      : explicit.length
        ? `explicit: ${explicit.length} command(s) from the request — wins`
        : 'explicit: supplied but declares no command — nothing to check',
  );
  if (!configConsulted) {
    notes.push(`${AGENTIC_CONFIG_PATH} (${label}): not consulted (an explicit list wins)`);
  } else if (!config.ok) {
    notes.push(`${AGENTIC_CONFIG_PATH} (${label}): unreadable — ${config.detail}`);
  } else if (sources.agenticConfig.kind === 'absent') {
    notes.push(`${AGENTIC_CONFIG_PATH} (${label}): absent`);
  } else if ((config.value ?? []).length === 0) {
    notes.push(`${AGENTIC_CONFIG_PATH} (${label}): present, no validation.commands — falls through`);
  } else {
    notes.push(`${AGENTIC_CONFIG_PATH} (${label}): ${(config.value ?? []).length} command(s) — wins`);
  }

  const manifestScripts = manifest.value?.scripts ?? {};
  const discovered = DISCOVERY_SCRIPT_NAMES.filter((name) => manifestScripts[name] !== undefined).map((name) =>
    name === 'test' ? 'npm test' : `npm run ${name}`,
  );

  const source: CheckCommandSource = explicitSupplied
    ? 'explicit'
    : (config.value ?? []).length
      ? 'agentic-config'
      : discovered.length
        ? 'package-json'
        : 'none';
  const commands = explicitSupplied ? explicit : (config.value ?? []).length ? (config.value ?? []) : discovered;

  if (sources.packageJson.kind === 'absent') {
    notes.push(`${PACKAGE_JSON_PATH} (${label}): absent — no npm script bodies to pin`);
  } else if (!manifest.ok) {
    notes.push(`${PACKAGE_JSON_PATH} (${label}): unreadable — ${manifest.detail}`);
  } else if (source === 'package-json') {
    notes.push(`${PACKAGE_JSON_PATH} (${label}): well-known script(s) ${discovered.map(npmScriptName).join(', ')} — wins`);
  } else if (source === 'none') {
    notes.push(`${PACKAGE_JSON_PATH} (${label}): no well-known script (${DISCOVERY_SCRIPT_NAMES.join('/')})`);
  } else {
    notes.push(`${PACKAGE_JSON_PATH} (${label}): consulted for script bodies only (a higher-precedence source won the list)`);
  }

  const makefilePresent = sources.makefile.kind !== 'absent';
  const makefileText = sources.makefile.kind === 'file' ? sources.makefile.text : '';
  const targets = makefileText ? makefileTargets(makefileText) : [];
  const makefilePinned = commands.some(commandInvokesMake);
  if (sources.makefile.kind === 'error') {
    // A huge Makefile used to overflow `git show`'s buffer and read as ABSENT —
    // which silently dropped it from the digest. A read that did not happen is
    // could-not-run when the make command would have run it.
    if (makefilePinned) malformed ??= { reason: 'unreadable-source', detail: `${MAKEFILE_PATH} (${label}): ${sources.makefile.message}` };
    notes.push(`${MAKEFILE_PATH} (${label}): ${sources.makefile.message}${makefilePinned ? ' — the make command pins it, so nothing may run' : ' — targets not surfaced'}`);
  } else if (!makefilePresent) {
    notes.push(`${MAKEFILE_PATH} (${label}): absent`);
  } else if (makefilePinned) {
    notes.push(`${MAKEFILE_PATH} (${label}): pinned by the make command in the list — targets surfaced, never run (${targets.map((t) => `make ${t}`).join(', ') || 'none in the first 50 lines'})`);
  } else {
    notes.push(`${MAKEFILE_PATH} (${label}): present, surfaced, never run (${targets.map((t) => `make ${t}`).join(', ') || 'no targets in the first 50 lines'})`);
  }

  const install = resolveInstall(sources);
  if (install.error) malformed ??= { reason: 'unreadable-source', detail: install.error };
  notes.push(
    install.kind === 'none'
      ? `install (${label}): nothing to install (no ${PACKAGE_JSON_PATH} and no ${PACKAGE_LOCK_PATH})`
      : `install (${label}): ${install.argv.join(' ')} — ${install.file} present`,
  );

  if (malformed) {
    return {
      label,
      source,
      commands: [],
      scripts: [],
      workspaceScripts: [],
      files: [],
      makefile: { present: makefilePresent, targets, text: makefileText, pinned: makefilePinned },
      install,
      malformed,
      notes,
      workspaceManifestPaths: [],
    };
  }

  // --- the bodies this plan would execute: the transitive npm-run closure of the
  //     list (with pre*/post* hooks), the local script files the argv names, and
  //     the install lifecycle hooks when an install step exists. A `-w` delegation
  //     pulls the delegated script (and its own closure) out of another manifest.
  const pinned = collectPinnedBodies({
    rootScripts: manifestScripts,
    commandRoots: commands,
    lifecycleRoots: install.kind === 'none' ? [] : INSTALL_LIFECYCLE_SCRIPTS,
    filePaths: scriptFilePaths(commands),
    readFile: sources.read,
    workspaces: createWorkspaceIndex(sources, manifest.value ?? { scripts: {} }),
    notes,
  });
  for (const error of pinned.errors) malformed ??= { reason: 'unreadable-source', detail: error };

  return {
    label,
    source,
    commands,
    scripts: pinned.scripts,
    workspaceScripts: pinned.workspaceScripts,
    files: pinned.files,
    makefile: { present: makefilePresent, targets, text: makefileText, pinned: makefilePinned },
    install,
    malformed,
    notes,
    workspaceManifestPaths: pinned.workspaceManifestPaths,
  };
}

function resolveInstall(sources: TreeSources): TreePlan['install'] {
  if (sources.packageLock.kind === 'error') {
    // Presence of the lockfile decides `npm ci` vs `npm install`; a lockfile that
    // is there but unreadable must not silently become "absent" and flip the argv.
    return { kind: 'none', argv: [], error: `${PACKAGE_LOCK_PATH} (${sources.label}): ${sources.packageLock.message}` };
  }
  if (sources.packageLock.kind === 'file') return { kind: 'ci', argv: ['npm', 'ci'], file: PACKAGE_LOCK_PATH };
  if (sources.packageJson.kind === 'file') return { kind: 'install', argv: ['npm', 'install'], file: PACKAGE_JSON_PATH };
  return { kind: 'none', argv: [] };
}

/**
 * Identity of the plan that would run: the ordered list, the resolved closure
 * (referenced scripts, their hooks, the whole npm-run chain), the local script
 * files named in argv, the workspace script bodies behind `-w` delegations (with
 * the manifest path that defines each), and the Makefile text when a make command
 * makes it a body. Deterministic — sorted bodies, no timestamps. Exactly what the
 * drift rule compares. `CHECK_PLAN_DIGEST_VERSION` is the shape version (v1 pinned
 * only directly referenced bodies; v2 added the closure and argv files; v3 adds
 * the workspace manifests) — bump it whenever the payload changes.
 */
function planDigest(plan: Pick<TreePlan, 'source' | 'commands' | 'scripts' | 'workspaceScripts' | 'files' | 'makefile'>): string {
  const payload = {
    version: CHECK_PLAN_DIGEST_VERSION,
    source: plan.source,
    commands: plan.commands,
    scripts: plan.scripts.map(({ name, body }) => ({ name, body })),
    workspaceScripts: plan.workspaceScripts.map(({ manifest, name, body }) => ({ manifest, name, body })),
    files: plan.files.map(({ path, text }) => ({ path, text })),
    makefile: plan.makefile.pinned ? plan.makefile.text : null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function bodyOf(plan: TreePlan, name: string): string | undefined {
  return plan.scripts.find((script) => script.name === name)?.body;
}

function diffSection(label: string, minus: string[], plus: string[]): string {
  return [`@@ ${label} @@`, ...minus.map((line) => `- ${line}`), ...plus.map((line) => `+ ${line}`)].join('\n');
}

const MISSING_BASE = '(no such script in the frozen base)';
const MISSING_CANDIDATE = '(no such script in the candidate)';

/**
 * The drift diff, and the drift predicate in one: a non-empty diff means the
 * candidate moved the pinned plan (or cannot be resolved), so nothing may run.
 * Rendering and deciding in one function is deliberate — a separate boolean is
 * how "the diff says nothing changed" and "we refused anyway" drift apart.
 */
function renderPlanDiff(base: TreePlan, candidate: TreePlan): string {
  const sections: string[] = [];
  if (candidate.malformed) {
    sections.push(diffSection('source', [base.source], [`unreadable — ${candidate.malformed.detail}`]));
  }
  if (base.commands.join('\n') !== candidate.commands.join('\n')) {
    sections.push(diffSection('commands', base.commands, candidate.commands));
  }
  const names = [...new Set([...base.scripts.map((s) => s.name), ...candidate.scripts.map((s) => s.name)])].sort();
  for (const name of names) {
    const before = bodyOf(base, name);
    const after = bodyOf(candidate, name);
    if (before === after) continue;
    sections.push(
      diffSection(
        `script:${name}`,
        before === undefined ? [MISSING_BASE] : before.split('\n'),
        after === undefined ? [MISSING_CANDIDATE] : after.split('\n'),
      ),
    );
  }
  const workspaceKeys = [
    ...new Set([
      ...base.workspaceScripts.map((script) => `${script.manifest}#${script.name}`),
      ...candidate.workspaceScripts.map((script) => `${script.manifest}#${script.name}`),
    ]),
  ].sort();
  for (const key of workspaceKeys) {
    const before = base.workspaceScripts.find((script) => `${script.manifest}#${script.name}` === key)?.body;
    const after = candidate.workspaceScripts.find((script) => `${script.manifest}#${script.name}` === key)?.body;
    if (before === after) continue;
    sections.push(
      diffSection(
        `workspace:${key}`,
        before === undefined ? [MISSING_BASE] : before.split('\n'),
        after === undefined ? [MISSING_CANDIDATE] : after.split('\n'),
      ),
    );
  }
  const filePaths = [...new Set([...base.files.map((f) => f.path), ...candidate.files.map((f) => f.path)])].sort();
  for (const path of filePaths) {
    const before = base.files.find((f) => f.path === path)?.text;
    const after = candidate.files.find((f) => f.path === path)?.text;
    if (before === after) continue;
    sections.push(
      diffSection(
        `file:${path}`,
        before === undefined ? [MISSING_BASE] : before.split('\n'),
        after === undefined ? [MISSING_CANDIDATE] : after.split('\n'),
      ),
    );
  }
  if (base.makefile.pinned && base.makefile.text !== candidate.makefile.text) {
    sections.push(diffSection(MAKEFILE_PATH, base.makefile.text.split('\n'), candidate.makefile.text.split('\n')));
  }
  const text = sections.join('\n');
  return text.length > CHECK_DIFF_CAP ? `${text.slice(0, CHECK_DIFF_CAP)}\n… (diff truncated at ${CHECK_DIFF_CAP} characters)` : text;
}

function resolvedCommands(plan: TreePlan): ResolvedCheckCommand[] {
  return plan.commands.map((command) => {
    const name = npmScriptName(command);
    if (name !== undefined) {
      const body = bodyOf(plan, name);
      if (body !== undefined) return { source: plan.source, command, script: { name, body } };
    }
    return { source: plan.source, command };
  });
}

function installPlan(base: TreePlan, baseLabel: string): CheckInstallPlan {
  if (base.install.error) return { kind: 'none', argv: [], because: base.install.error };
  if (base.install.kind === 'none') {
    return { kind: 'none', argv: [], because: `no ${PACKAGE_JSON_PATH} and no ${PACKAGE_LOCK_PATH} in ${baseLabel}` };
  }
  return { kind: base.install.kind, argv: base.install.argv, because: `${base.install.file} present in ${baseLabel}` };
}

/**
 * The entry point: resolve the pinned plan for `baseSha`, compare it to the
 * candidate tree at `repoRoot`, and return what may run — which is nothing at
 * all unless the two agree. Reads only; executes only fixed-argv `git`.
 */
export function resolveCheckCommands(options: ResolveCheckCommandsOptions): CheckCommandResolution {
  const frozen = createFrozenBase(options.repoRoot, options.baseSha);
  if (frozen.kind === 'error') {
    const empty: TreePlan = {
      label: `base ${shortSha(options.baseSha)}`,
      source: 'none',
      commands: [],
      scripts: [],
      workspaceScripts: [],
      files: [],
      makefile: { present: false, targets: [], text: '', pinned: false },
      install: { kind: 'none', argv: [] },
      notes: [],
      workspaceManifestPaths: [],
    };
    return {
      status: 'could-not-run',
      reason: 'unreadable-base',
      source: 'none',
      commands: [],
      digest: planDigest(empty),
      changedVsBase: false,
      diff: '',
      notes: [`frozen base ${shortSha(options.baseSha)}: unreadable — ${frozen.detail}`, 'could-not-run: the base pins nothing, so nothing may run'],
      makefile: { present: false, targets: [] },
      install: { kind: 'none', argv: [], because: `the frozen base could not be read: ${frozen.detail}` },
    };
  }

  const baseLabel = `base ${frozen.base.shortSha}`;
  const base = planFromSources({
    label: baseLabel,
    explicit: options.explicit,
    agenticConfig: frozen.base.read(AGENTIC_CONFIG_PATH),
    packageJson: frozen.base.read(PACKAGE_JSON_PATH),
    packageLock: frozen.base.read(PACKAGE_LOCK_PATH),
    makefile: frozen.base.read(MAKEFILE_PATH),
    read: frozen.base.read,
    listPaths: frozen.base.listPaths,
  });
  const candidate = planFromSources({
    label: 'candidate (working tree)',
    explicit: options.explicit,
    agenticConfig: readWorkingFile(options.repoRoot, AGENTIC_CONFIG_PATH),
    packageJson: readWorkingFile(options.repoRoot, PACKAGE_JSON_PATH),
    packageLock: readWorkingFile(options.repoRoot, PACKAGE_LOCK_PATH),
    makefile: readWorkingFile(options.repoRoot, MAKEFILE_PATH),
    read: (path: string) => readWorkingFile(options.repoRoot, path),
    // The plan that would run is the base's, so the candidate resolves the SAME
    // workspace manifests — read from the working tree, which is what turns a
    // neutered workspace script body into a drift line.
    workspaceManifestPaths: base.workspaceManifestPaths,
  });

  const diff = renderPlanDiff(base, candidate);
  const notes = [...base.notes];
  const digest = planDigest(base);
  const makefile = { present: base.makefile.present, targets: base.makefile.targets };
  const install = installPlan(base, baseLabel);

  if (base.malformed) {
    return {
      status: 'could-not-run',
      reason: base.malformed.reason,
      source: base.source,
      commands: [],
      digest,
      changedVsBase: false,
      diff: '',
      notes: [...notes, `could-not-run: ${base.malformed.detail}`, 'could-not-run: a source present but unusable is never a silent fallback — nothing may run'],
      makefile,
      install,
    };
  }

  if (base.commands.length === 0 && candidate.commands.length === 0 && !candidate.malformed) {
    return {
      status: 'nothing-to-check',
      reason: 'no-commands',
      source: base.source,
      commands: [],
      digest,
      changedVsBase: false,
      diff: '',
      notes: [...notes, 'no-commands: no source declares a command — nothing to run'],
      makefile,
      install,
    };
  }

  if (diff) {
    return {
      status: 'nothing-to-check',
      reason: 'commands-changed-vs-base',
      source: base.source,
      commands: [],
      digest,
      changedVsBase: true,
      diff,
      notes: [
        ...notes,
        `candidate (working tree): ${candidate.malformed ? candidate.malformed.detail : `${candidate.commands.length} command(s) resolved from ${candidate.source}`}`,
        'commands-changed-vs-base: the candidate moved the pinned plan — nothing was run',
      ],
      makefile,
      install,
    };
  }

  return {
    status: 'resolved',
    source: base.source,
    commands: resolvedCommands(base),
    digest,
    changedVsBase: false,
    diff: '',
    notes,
    makefile,
    install,
  };
}
