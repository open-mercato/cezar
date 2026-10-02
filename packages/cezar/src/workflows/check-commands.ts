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
 * ever spawns are `git rev-parse` (one probe, to tell "no such file in this tree"
 * from "this base is not readable") and `git show <sha>:<path>` (the frozen-base
 * read) — both fixed argv, no shell, never a string from either tree. A caller
 * (PR 4's core) hands `commands` to `runCheckCommand`; a `nothing-to-check` or
 * `could-not-run` resolution never yields a command to run at all.
 *
 * Vocabulary (the spec's, `## Acceptance Criteria for PRs 2–6`, PR 3):
 *  - `resolved`             — a non-empty list, identical in base and candidate;
 *  - `nothing-to-check`     — `no-commands` (no source declares anything) or
 *                             `commands-changed-vs-base` (drift; `diff` says how);
 *  - `could-not-run`        — a source was present but unusable. Never a silent
 *                             fallback to a lower-precedence source.
 * `nothing-to-check` is not green and `commands` is empty on every non-`resolved`
 * status, so a caller that ignores `status` still has nothing to execute.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * `npm install`. Their bodies execute as part of the install step, so they are
 * pinned with the list whenever an install step exists.
 */
const INSTALL_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

/** How much of a drift diff is kept. A moved body is the interesting part, and a
 *  manifest diff cannot usefully exceed this. */
export const CHECK_DIFF_CAP = 20_000;

export type CheckCommandSource = 'explicit' | 'agentic-config' | 'package-json' | 'none';

export type CheckCommandReason =
  | 'no-commands'
  | 'commands-changed-vs-base'
  | 'malformed-agentic-config'
  | 'malformed-package-json'
  | 'unreadable-base';

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

/** Everything one tree resolves to; base and candidate are built the same way. */
interface TreePlan {
  label: string;
  source: CheckCommandSource;
  commands: string[];
  /** Referenced scripts + their pre/post hooks + the install lifecycle hooks, sorted by name. */
  scripts: ScriptBody[];
  makefile: { present: boolean; targets: string[]; text: string; pinned: boolean };
  install: { kind: InstallKind; argv: string[]; file?: string };
  /** The tree's consulted source is present but unusable — the plan stops there. */
  malformed?: { reason: CheckCommandReason; detail: string };
  notes: string[];
}

interface FrozenBase {
  shortSha: string;
  read(path: string): TreeFile;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

/** `git`, no shell, never throws — degradation is the caller's policy. */
function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: failure.stdout ?? '', stderr: (failure.stderr ?? failure.message ?? 'git failed').trim() };
  }
}

/**
 * Open the frozen base for reading. One probe decides whether the base is
 * readable at all: `git cat-file -e` cannot separate "no such path" from "no
 * such object" (both exit 128), so the probe is `rev-parse --verify --quiet`
 * and every later `git show` failure then means exactly one thing — the path is
 * absent from that tree. Never throws; an unreadable base is a value.
 */
function createFrozenBase(repoRoot: string, baseSha: string): { kind: 'ok'; base: FrozenBase } | { kind: 'error'; detail: string } {
  const probe = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`]);
  if (!probe.ok) {
    return { kind: 'error', detail: `git rev-parse ${shortSha(baseSha)}^{commit} failed: ${probe.stderr || 'git is not available'}` };
  }
  const cache = new Map<string, TreeFile>();
  return {
    kind: 'ok',
    base: {
      shortSha: shortSha(baseSha),
      read(path: string): TreeFile {
        const cached = cache.get(path);
        if (cached) return cached;
        // A FIXED argv: the only tree-supplied part is the path constant above.
        const show = git(repoRoot, ['show', `${baseSha}:${path}`]);
        const result: TreeFile = show.ok ? { kind: 'file', text: show.stdout } : { kind: 'absent' };
        cache.set(path, result);
        return result;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParseResult<T> {
  ok: boolean;
  value?: T;
  detail?: string;
}

function parseManifest(file: TreeFile, label: string): ParseResult<Record<string, string>> {
  if (file.kind === 'absent') return { ok: true, value: {} };
  if (file.kind === 'error') return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}): ${file.message}` };
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (err) {
    return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}) is not valid JSON: ${(err as Error).message}` };
  }
  if (!isObject(raw)) return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}) is not a JSON object` };
  const scripts = raw['scripts'];
  if (scripts === undefined) return { ok: true, value: {} };
  if (!isObject(scripts)) return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}): "scripts" is not an object` };
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') return { ok: false, detail: `${PACKAGE_JSON_PATH} (${label}): script "${name}" is not a string` };
    out[name] = body;
  }
  return { ok: true, value: out };
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

  const explicit = normalizeCommands(sources.explicit ?? []);
  const configConsulted = explicit.length === 0;
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
  notes.push(explicit.length ? `explicit: ${explicit.length} command(s) from the request — wins` : 'explicit: not supplied');
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

  const manifestScripts = manifest.value ?? {};
  const discovered = DISCOVERY_SCRIPT_NAMES.filter((name) => manifestScripts[name] !== undefined).map((name) =>
    name === 'test' ? 'npm test' : `npm run ${name}`,
  );

  const source: CheckCommandSource = explicit.length
    ? 'explicit'
    : (config.value ?? []).length
      ? 'agentic-config'
      : discovered.length
        ? 'package-json'
        : 'none';
  const commands = explicit.length ? explicit : (config.value ?? []).length ? (config.value ?? []) : discovered;

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

  const makefilePresent = sources.makefile.kind === 'file';
  const makefileText = sources.makefile.kind === 'file' ? sources.makefile.text : '';
  const targets = makefilePresent ? makefileTargets(makefileText) : [];
  const makefilePinned = commands.some(commandInvokesMake);
  if (!makefilePresent) {
    notes.push(`${MAKEFILE_PATH} (${label}): absent`);
  } else if (makefilePinned) {
    notes.push(`${MAKEFILE_PATH} (${label}): pinned by the make command in the list — targets surfaced, never run (${targets.map((t) => `make ${t}`).join(', ') || 'none in the first 50 lines'})`);
  } else {
    notes.push(`${MAKEFILE_PATH} (${label}): present, surfaced, never run (${targets.map((t) => `make ${t}`).join(', ') || 'no targets in the first 50 lines'})`);
  }

  const install = resolveInstall(sources);
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
      makefile: { present: makefilePresent, targets, text: makefileText, pinned: makefilePinned },
      install,
      malformed,
      notes,
    };
  }

  // --- the bodies this plan would execute: referenced npm scripts (+ their npm
  //     pre/post hooks), and the root lifecycle hooks the install step runs.
  const scripts = new Map<string, string>();
  const addScript = (name: string): void => {
    const body = manifestScripts[name];
    if (body === undefined || scripts.has(name)) return;
    scripts.set(name, body);
  };
  for (const command of commands) {
    const name = npmScriptName(command);
    if (!name) continue;
    if (manifestScripts[name] === undefined) {
      notes.push(`${command}: the frozen base resolves no "${name}" script — the argv is pinned, its body is not`);
      continue;
    }
    addScript(name);
    addScript(`pre${name}`);
    addScript(`post${name}`);
  }
  if (install.kind !== 'none') for (const name of INSTALL_LIFECYCLE_SCRIPTS) addScript(name);

  return {
    label,
    source,
    commands,
    scripts: [...scripts.entries()]
      .map(([name, body]) => ({ name, body }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    makefile: { present: makefilePresent, targets, text: makefileText, pinned: makefilePinned },
    install,
    notes,
  };
}

function resolveInstall(sources: TreeSources): TreePlan['install'] {
  if (sources.packageLock.kind === 'file') return { kind: 'ci', argv: ['npm', 'ci'], file: PACKAGE_LOCK_PATH };
  if (sources.packageJson.kind === 'file') return { kind: 'install', argv: ['npm', 'install'], file: PACKAGE_JSON_PATH };
  return { kind: 'none', argv: [] };
}

/**
 * Identity of the plan that would run: the ordered list, the resolved bodies
 * (referenced scripts, their hooks, the install lifecycle hooks) and the
 * Makefile text when a make command makes it a body. Deterministic — sorted
 * bodies, no paths, no timestamps. Exactly what the drift rule compares.
 */
function planDigest(plan: Pick<TreePlan, 'source' | 'commands' | 'scripts' | 'makefile'>): string {
  const payload = {
    version: 1,
    source: plan.source,
    commands: plan.commands,
    scripts: plan.scripts.map(({ name, body }) => ({ name, body })),
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
      makefile: { present: false, targets: [], text: '', pinned: false },
      install: { kind: 'none', argv: [] },
      notes: [],
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
  });
  const candidate = planFromSources({
    label: 'candidate (working tree)',
    explicit: options.explicit,
    agenticConfig: readWorkingFile(options.repoRoot, AGENTIC_CONFIG_PATH),
    packageJson: readWorkingFile(options.repoRoot, PACKAGE_JSON_PATH),
    packageLock: readWorkingFile(options.repoRoot, PACKAGE_LOCK_PATH),
    makefile: readWorkingFile(options.repoRoot, MAKEFILE_PATH),
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
      source: 'none',
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
