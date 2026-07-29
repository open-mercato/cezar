import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { discoverSkills, type Skill } from '../skills.js';
import type { HarnessValidationCheck } from './types.js';

/**
 * The runtime bridge (spec 2026-07-23-harness-orchestration, Architecture §2):
 * cezar's process-level seam to the installed `cez-harness` deterministic
 * runtime. Everything model- and mechanics-shaped stays in `harness.mjs`;
 * this module only spawns it safely — argument arrays, no shell, bounded by a
 * timeout, killable on cancel — plus the two host jobs the wrapper contracts
 * assign to the conductor: the trusted config snapshot (from the BASE
 * revision, never the task branch) and the validation gate's real command
 * evidence.
 */

const OP_OUTPUT_CAP = 200_000;
const DEFAULT_OP_TIMEOUT_MS = 10 * 60_000;
const VALIDATION_TIMEOUT_MS = 30 * 60_000;
const PROCESS_KILL_GRACE_MS = 5_000;

const HARNESS_BASE_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
]);

export function harnessChildEnvironment(
  explicitNames: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const names = new Set([...HARNESS_BASE_ENV, ...explicitNames]);
  const result: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** Credential/binary variables declared by the trusted config. Values are never copied into
 * artifacts; only the names cross this boundary and the runtime receives their current values. */
export function harnessConfigEnvironmentNames(agentHarness: Record<string, unknown> | undefined): string[] {
  const models =
    agentHarness?.models && typeof agentHarness.models === 'object' && !Array.isArray(agentHarness.models)
      ? (agentHarness.models as Record<string, unknown>)
      : {};
  const names = new Set<string>();
  for (const value of Object.values(models)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const model = value as Record<string, unknown>;
    for (const key of ['credentialEnv', 'binaryEnv']) {
      if (typeof model[key] === 'string') names.add(model[key]);
    }
  }
  return [...names];
}

function signalProcessTreePid(pid: number | undefined, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, signal);
      } catch {
      }
    }
  }
}

function signalProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  signalProcessTreePid(child.pid, signal);
}

export function terminateProcessTree(
  child: ChildProcess,
  identity?: HarnessProcessIdentity,
): void {
  signalProcessTree(child, 'SIGTERM');
  const watchdog = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (identity && processHasToken(identity) !== true) return;
    if (identity) signalOwnedProcess(identity, 'SIGKILL');
    else signalProcessTree(child, 'SIGKILL');
  }, PROCESS_KILL_GRACE_MS);
  child.once('close', () => clearTimeout(watchdog));
  watchdog.unref?.();
}

export interface HarnessProcessIdentity {
  pid: number;
  token: string;
  startedAt: string;
  group?: boolean;
}

export type ReconcileHarnessProcessResult =
  | { status: 'absent' | 'terminated' }
  | { status: 'mismatch' | 'unverified'; error: string };

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processHasToken(identity: HarnessProcessIdentity): boolean | null {
  if (!processExists(identity.pid)) return false;
  try {
    if (process.platform === 'linux') {
      const environment = readFileSync(`/proc/${identity.pid}/environ`);
      return environment
        .toString('utf8')
        .split('\0')
        .includes(`CEZ_PROCESS_TOKEN=${identity.token}`);
    }
    if (process.platform === 'darwin') {
      const environment = execFileSync(
        'ps',
        ['eww', '-p', String(identity.pid), '-o', 'command='],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      );
      return environment.includes(`CEZ_PROCESS_TOKEN=${identity.token}`);
    }
    return null;
  } catch {
    return processExists(identity.pid) ? null : false;
  }
}

function signalOwnedProcess(
  identity: HarnessProcessIdentity,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (identity.group !== false) {
    signalProcessTreePid(identity.pid, signal);
    return;
  }
  try {
    process.kill(identity.pid, signal);
  } catch {
  }
}

/** Reconcile one process recorded by a paid invocation after a Cezar restart. Only a matching
 * identity token authorizes group termination; unsupported inspection fails closed. */
export async function reconcileHarnessProcess(
  identity: HarnessProcessIdentity,
): Promise<ReconcileHarnessProcessResult> {
  const match = processHasToken(identity);
  if (match === false) {
    return processExists(identity.pid)
      ? { status: 'mismatch', error: `pid ${identity.pid} no longer belongs to this harness invocation` }
      : { status: 'absent' };
  }
  if (match === null) {
    return {
      status: 'unverified',
      error: `cannot verify process identity for pid ${identity.pid} on ${process.platform}`,
    };
  }
  signalOwnedProcess(identity, 'SIGTERM');
  const deadline = Date.now() + PROCESS_KILL_GRACE_MS;
  while (Date.now() < deadline) {
    if (!processExists(identity.pid)) return { status: 'terminated' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stillMatches = processHasToken(identity);
  if (stillMatches !== true) {
    return stillMatches === false && !processExists(identity.pid)
      ? { status: 'terminated' }
      : {
          status: stillMatches === false ? 'mismatch' : 'unverified',
          error: `process identity changed while terminating pid ${identity.pid}`,
        };
  }
  signalOwnedProcess(identity, 'SIGKILL');
  const killDeadline = Date.now() + PROCESS_KILL_GRACE_MS;
  while (Date.now() < killDeadline) {
    if (!processExists(identity.pid)) return { status: 'terminated' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const afterKill = processHasToken(identity);
  if (afterKill === false && !processExists(identity.pid)) return { status: 'terminated' };
  return {
    status: afterKill === false ? 'mismatch' : 'unverified',
    error:
      afterKill === true
        ? `process group ${identity.pid} did not exit after SIGKILL`
        : `could not verify termination of process group ${identity.pid}`,
  };
}

export interface HarnessOpResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

/** The materialized skill script inside a run's cwd (worktree), or null.
 *  `ensureSkillOnDisk` copies the whole skill directory — scripts included —
 *  so after materialization this is simply a path probe.
 *
 *  NOTE: this path is MODEL-WRITABLE. Never spawn it directly; take the sealed
 *  copy `sealHarnessRuntime` produces and verify it with `harnessScriptDigest`. */
export function resolveHarnessScript(cwd: string): string | null {
  const path = join(cwd, '.claude', 'skills', 'cez-harness', 'scripts', 'harness.mjs');
  return existsSync(path) ? path : null;
}

function copyTreeByValue(source: string, dest: string): void {
  const stat = statSync(source); // statSync follows links, lstatSync would not
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyTreeByValue(join(source, entry), join(dest, entry));
    }
    return;
  }
  if (!stat.isFile()) return; // sockets/fifos have no place in a sealed runtime
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(source));
}

/** sha256 of the runtime's bytes, or null when it is gone. */
export function harnessScriptDigest(script: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(script)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Copy the materialized skill tree OUT of the worktree and return the sealed
 * runtime path plus its digest (review 2026-07-27).
 *
 * The whole `.claude/skills` subtree comes along, not just `harness.mjs`: the
 * runtime resolves `../references/*.schema.json` and
 * `../../cez-code-review/references/*.md` relative to its own location, so the
 * layout has to survive the move.
 *
 * This alone stops the sandboxed codex worker (`--sandbox workspace-write --cd
 * {worktree}`), which cannot reach outside the worktree at all. An agent phase
 * with an unrestricted Bash tool still could, which is why the digest is pinned
 * in the ledger and re-checked before every op rather than trusted once.
 */
export function sealHarnessRuntime(
  cwd: string,
  destDir: string,
): { script: string; sha256: string } | null {
  const source = join(cwd, '.claude', 'skills');
  if (!existsSync(join(source, 'cez-harness', 'scripts', 'harness.mjs'))) return null;
  const skillsDest = join(destDir, 'skills');
  rmSync(skillsDest, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  copyTreeByValue(source, skillsDest);
  const script = join(skillsDest, 'cez-harness', 'scripts', 'harness.mjs');
  const sha256 = harnessScriptDigest(script);
  return sha256 ? { script, sha256 } : null;
}

export interface HarnessRuntimeInfo {
  installed: boolean;
  source: Skill['source'] | null;
  commit: string | null;
}

/**
 * Where this cezar would get the harness collection from, before any run
 * exists — the status surface's honesty check (spec
 * 2026-07-24-vendored-cez-skills). A packaged cezar always answers
 * `bundled` + the vendor manifest's pinned commit; repo-local or team
 * overrides win the catalog and are reported as themselves.
 */
export async function resolveHarnessRuntimeInfo(
  repoRoot: string,
  opts: { bundledDir?: string | null } = {},
): Promise<HarnessRuntimeInfo> {
  const catalog = await discoverSkills(repoRoot, opts).catch(() => [] as Skill[]);
  const skill = catalog.find((s) => s.name === 'cez-harness');
  if (!skill) return { installed: false, source: null, commit: null };
  if (skill.source === 'team') {
    return { installed: true, source: 'team', commit: skill.team?.commit ?? null };
  }
  const skillDir = dirname(skill.path);
  const installed = skill.path.endsWith('SKILL.md') && existsSync(join(skillDir, 'scripts', 'harness.mjs'));
  let commit: string | null = null;
  if (skill.source === 'bundled') {
    try {
      const manifest = JSON.parse(await readFile(join(dirname(skillDir), 'MANIFEST.json'), 'utf8')) as {
        source?: { commit?: unknown };
      };
      commit = typeof manifest.source?.commit === 'string' ? manifest.source.commit : null;
    } catch {
      commit = null;
    }
  }
  return { installed, source: skill.source, commit };
}

export class HarnessRuntime {
  private current: ChildProcess | null = null;
  private currentIdentity: HarnessProcessIdentity | null = null;
  private killed = false;

  constructor(
    private readonly opts: {
      script: string;
      cwd: string;
      env?: Record<string, string>;
    },
  ) {}

  kill(): void {
    this.killed = true;
    if (this.current) terminateProcessTree(this.current, this.currentIdentity ?? undefined);
  }

  run(
    op: string,
    args: string[],
    opts: {
      timeoutMs?: number;
      onSpawn?: (identity: HarnessProcessIdentity) => void;
    } = {},
  ): Promise<HarnessOpResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const processToken = randomProcessToken();
      const child = spawn(process.execPath, [this.opts.script, op, ...args], {
        cwd: this.opts.cwd,
        env: {
          ...harnessChildEnvironment(),
          ...this.opts.env,
          CEZ_PROCESS_TOKEN: processToken,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.current = child;
      const identity: HarnessProcessIdentity | undefined = child.pid
        ? {
            pid: child.pid,
            token: processToken,
            startedAt: new Date().toISOString(),
            group: true,
          }
        : undefined;
      this.currentIdentity = identity ?? null;
      if (child.pid) {
        try {
          opts.onSpawn?.(identity!);
        } catch (error) {
          terminateProcessTree(child, identity);
          this.current = null;
          this.currentIdentity = null;
          resolve({
            ok: false,
            exitCode: null,
            stdout: '',
            stderr: '',
            error: `could not persist process identity: ${
              error instanceof Error ? error.message : String(error)
            }`,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
      }
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, identity);
      }, timeoutMs);
      timer.unref?.();
      const collect = (sink: 'out' | 'err') => (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (sink === 'out' && stdout.length < OP_OUTPUT_CAP) {
          stdout += text.slice(0, OP_OUTPUT_CAP - stdout.length);
        }
        if (sink === 'err' && stderr.length < OP_OUTPUT_CAP) {
          stderr += text.slice(0, OP_OUTPUT_CAP - stderr.length);
        }
      };
      child.stdout?.on('data', collect('out'));
      child.stderr?.on('data', collect('err'));
      const settle = (result: Omit<HarnessOpResult, 'durationMs'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.current = null;
        this.currentIdentity = null;
        resolve({ ...result, durationMs: Date.now() - startedAt });
      };
      child.on('error', (err) => {
        settle({ ok: false, exitCode: null, stdout, stderr, error: `failed to spawn: ${err.message}` });
      });
      child.on('close', (code) => {
        if (timedOut) {
          settle({ ok: false, exitCode: code, stdout, stderr, error: `op "${op}" timed out after ${timeoutMs}ms` });
          return;
        }
        if (this.killed) {
          settle({ ok: false, exitCode: code, stdout, stderr, error: `op "${op}" cancelled` });
          return;
        }
        settle({ ok: code === 0, exitCode: code, stdout, stderr });
      });
    });
  }
}

function randomProcessToken(): string {
  return randomUUID();
}

const agenticConfigSchema = z
  .object({
    baseBranch: z.string().optional(),
    validation: z.object({ commands: z.array(z.string()).default([]) }).optional(),
    agentHarness: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface AgenticConfig {
  baseBranch: string | undefined;
  validationCommands: string[];
  agentHarness: Record<string, unknown> | undefined;
}

/** Read one already-selected config file. Harness recovery uses this form so
 * model edits in the task worktree can never change executable commands. */
export async function loadAgenticConfigFile(path: string): Promise<AgenticConfig> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const parsed = agenticConfigSchema.safeParse(raw);
    if (!parsed.success) return { baseBranch: undefined, validationCommands: [], agentHarness: undefined };
    return {
      baseBranch: parsed.data.baseBranch,
      validationCommands: parsed.data.validation?.commands ?? [],
      agentHarness: parsed.data.agentHarness,
    };
  } catch {
    return { baseBranch: undefined, validationCommands: [], agentHarness: undefined };
  }
}

/** Read the worktree's `.ai/agentic.config.json` — the om pipeline's config,
 *  which cezar reads and never writes. Missing/invalid degrades to defaults. */
export async function loadAgenticConfig(cwd: string): Promise<AgenticConfig> {
  return loadAgenticConfigFile(join(cwd, '.ai', 'agentic.config.json'));
}

/**
 * Export `.ai/agentic.config.json` from the BASE revision into `destDir`
 * (the trusted-config rule from `references/issue-workflow.md`: never execute
 * adapter settings from the task branch). Returns the snapshot path and the
 * pinned `ref@sha`, or null when the base has no config (a `standard` run
 * needs none).
 */
export async function exportTrustedConfig(
  repoRoot: string,
  baseRef: string,
  destDir: string,
): Promise<{ path: string; ref: string } | null> {
  if (!baseRef || baseRef.startsWith('-')) return null;
  const git = (args: string[]) =>
    new Promise<{ ok: boolean; stdout: string }>((resolve) => {
      execFile(
        'git',
        args,
        { cwd: repoRoot, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout) => resolve({ ok: !err, stdout: stdout ?? '' }),
      );
    });
  const sha = await git(['rev-parse', '--short', `${baseRef}^{commit}`]);
  if (!sha.ok) return null;
  const show = await git(['show', `${baseRef}:.ai/agentic.config.json`]);
  if (!show.ok) return null;
  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, 'trusted-agentic.config.json');
  writeFileSync(path, show.stdout, 'utf8');
  return { path, ref: `${baseRef}@${sha.stdout.trim()}` };
}

const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

const FAILURE_LINE_PATTERNS: RegExp[] = [
  /(^|\s)FAIL\s/,
  /^\s*Failed:\s+\S/,
  /ERROR\s+(run failed|command)/,
  /\bTest Suites:\s+\d+\s+failed/,
  /\bTests:\s+\d+\s+failed/,
  /(^|\s)●\s/,
  /\berror TS\d+/,
  /npm ERR!|ELIFECYCLE|Command failed with exit code|error Command failed/,
  /JavaScript heap out of memory|FATAL ERROR/,
];

const EVIDENCE_MAX_CHARS = 6_000;
const EVIDENCE_MAX_MATCHED_LINES = 80;
const EVIDENCE_TAIL_LINES = 12;

/**
 * Extract the failure-relevant lines from a validation command's output.
 *
 * Run c54c2ed4 died with evidence quoting a PASSING package: `yarn test` was
 * ~1 MB of interleaved turbo output and the evidence was "the last 8 lines" of
 * a head-truncated capture — 8 lines from mid-stream. A repair agent (and the
 * final failure report) needs the `FAIL` blocks and the runner's own verdict
 * lines wherever they sit in the stream, plus the true tail for context.
 */
export function extractFailureEvidence(output: string): string {
  const lines = output.replace(ANSI_PATTERN, '').split('\n');
  const matchedIndexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    if (FAILURE_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      matchedIndexes.push(index);
    }
  }
  const clip = (line: string) => (line.length > 400 ? `${line.slice(0, 400)}…` : line);
  let matched: string[];
  if (matchedIndexes.length > EVIDENCE_MAX_MATCHED_LINES) {
    const half = EVIDENCE_MAX_MATCHED_LINES / 2;
    matched = [
      ...matchedIndexes.slice(0, half).map((i) => clip(lines[i]!)),
      `… (${matchedIndexes.length - EVIDENCE_MAX_MATCHED_LINES} more matching lines elided)`,
      ...matchedIndexes.slice(-half).map((i) => clip(lines[i]!)),
    ];
  } else {
    matched = matchedIndexes.map((i) => clip(lines[i]!));
  }
  const matchedSet = new Set(matchedIndexes);
  const tailStart = Math.max(0, lines.length - EVIDENCE_TAIL_LINES);
  const tail = lines
    .slice(tailStart)
    .map((line, offset) => ({ line, index: tailStart + offset }))
    .filter(({ line, index }) => line.trim().length > 0 && !matchedSet.has(index))
    .map(({ line }) => clip(line));
  const parts = [...matched];
  if (tail.length > 0) {
    if (matched.length > 0) parts.push('— output tail —');
    parts.push(...tail);
  }
  let evidence = parts.join('\n').trim();
  if (evidence.length > EVIDENCE_MAX_CHARS) {
    const keep = EVIDENCE_MAX_CHARS / 2;
    evidence = `${evidence.slice(0, keep)}\n… (evidence trimmed) …\n${evidence.slice(-keep)}`;
  }
  return evidence;
}

/**
 * Normalize a command's output into stable failing-test identities: jest
 * `FAIL <path>` suites, turbo `Failed: <pkg#task>` tasks, and tsc
 * `file: error TSxxxx` pairs (line numbers dropped — they shift under
 * unrelated edits). These are the delta-gate's comparison keys, so they must
 * be reproducible across runs of the same tree.
 */
export function extractFailingTestIds(output: string): string[] {
  const ids = new Set<string>();
  const clean = output.replace(ANSI_PATTERN, '');
  for (const line of clean.split('\n')) {
    const fail = /(?:^|\s)FAIL\s+(\S+)/.exec(line);
    if (fail && /[./]/.test(fail[1]!)) ids.add(`fail:${fail[1]}`);
    const failedTasks = /^\s*Failed:\s+(.+)$/.exec(line);
    if (failedTasks) {
      for (const token of failedTasks[1]!.split(/[,\s]+/)) {
        if (token.includes('#')) ids.add(`task:${token}`);
      }
    }
    const tsc = /(?:^|\s)([^\s()]+)\(\d+,\d+\):\s+error\s+(TS\d+)/.exec(line);
    if (tsc) ids.add(`ts:${tsc[1]}:${tsc[2]}`);
  }
  return [...ids];
}

export type GateRegressionCheck = HarnessValidationCheck & {
  newFailureIds?: string[];
};

/**
 * Split the gate's failed checks into regressions this run must answer for and
 * failures the baseline already had. A failed check is tolerated only when the
 * same command already failed on the untouched worktree AND its failing-test
 * identities are a subset of the baseline's (or neither side has comparable
 * identities). Timed-out checks are never tolerated — a partial stream proves
 * nothing about identity. Tolerated checks are marked `preexisting` in place so
 * the persisted artifact carries the verdict.
 */
export function computeGateRegressions(
  current: HarnessValidationCheck[],
  baseline: HarnessValidationCheck[] | undefined,
): {
  blocking: GateRegressionCheck[];
  tolerated: Array<{ check: HarnessValidationCheck; reason: string }>;
} {
  const blocking: GateRegressionCheck[] = [];
  const tolerated: Array<{ check: HarnessValidationCheck; reason: string }> = [];
  for (const check of current) {
    if (check.status !== 'failed') continue;
    const base = baseline?.find((entry) => entry.command === check.command);
    if (!base || base.status !== 'failed' || check.timedOut) {
      blocking.push(check);
      continue;
    }
    const currentIds = check.failureIds ?? [];
    const baseIds = new Set(base.failureIds ?? []);
    if (currentIds.length === 0 && baseIds.size === 0) {
      check.preexisting = true;
      tolerated.push({
        check,
        reason: `\`${check.command}\` already failed at baseline (no comparable failure identities)`,
      });
      continue;
    }
    const newIds = currentIds.filter((id) => !baseIds.has(id));
    if (currentIds.length > 0 && newIds.length === 0) {
      check.preexisting = true;
      tolerated.push({
        check,
        reason: `\`${check.command}\` fails exactly as it did at baseline (${currentIds.join(', ')})`,
      });
      continue;
    }
    blocking.push(newIds.length > 0 ? Object.assign(check, { newFailureIds: newIds }) : check);
  }
  return { blocking, tolerated };
}

/**
 * Run the repo's configured validation commands in order, recording the real
 * status, exit code and observed output for each — the gate takes trusted
 * command output, never a model's claim. Later commands after a failure are
 * recorded as `skipped` so the evidence always covers the whole list.
 */
export async function runValidationCommands(
  commands: string[],
  cwd: string,
  opts: {
    timeoutMs?: number;
    onOutput?: (command: string, text: string) => void;
    onSpawn?: (identity: HarnessProcessIdentity, command: string, index: number) => void;
    onExit?: (command: string, index: number) => void;
    signal?: AbortSignal;
    env?: Record<string, string>;
    logDir?: string;
    logPrefix?: string;
  } = {},
): Promise<HarnessValidationCheck[]> {
  const checks: HarnessValidationCheck[] = [];
  let failed = false;
  const baseEnvironment = {
    ...harnessChildEnvironment(),
    ...opts.env,
  };
  let corepackShimDir: string | undefined;
  try {
    const packageManager = (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
          packageManager?: unknown;
        };
        return typeof pkg.packageManager === 'string' ? pkg.packageManager : undefined;
      } catch {
        return undefined;
      }
    })();
    if (packageManager && /^(?:yarn|pnpm)@/.test(packageManager)) {
      const candidate = mkdtempSync(join(tmpdir(), 'cez-corepack-'));
      try {
        execFileSync('corepack', ['enable', '--install-directory', candidate], {
          cwd,
          env: baseEnvironment,
          stdio: 'ignore',
          timeout: 10_000,
        });
        corepackShimDir = candidate;
      } catch {
        rmSync(candidate, { recursive: true, force: true });
      }
    }
    const validationEnvironment = {
      ...baseEnvironment,
      ...(corepackShimDir
        ? {
            PATH: `${corepackShimDir}${
              process.platform === 'win32' ? ';' : ':'
            }${baseEnvironment.PATH ?? ''}`,
          }
        : {}),
    };
    for (const [index, command] of commands.entries()) {
      if (failed) {
        checks.push({ command, status: 'skipped', exitCode: null, evidence: 'skipped — a previous command failed' });
        continue;
      }
      if (opts.signal?.aborted) {
        checks.push({ command, status: 'skipped', exitCode: null, evidence: 'skipped — validation cancelled' });
        failed = true;
        continue;
      }
      const timeoutMs = opts.timeoutMs ?? VALIDATION_TIMEOUT_MS;
      const result = await new Promise<{
        code: number | null;
        output: string;
        droppedBytes: number;
        timedOut: boolean;
      }>((resolve) => {
        const processToken = randomProcessToken();
        const child = spawn('bash', ['-lc', command], {
          cwd,
          env: {
            ...validationEnvironment,
            CEZ_PROCESS_TOKEN: processToken,
          },
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
        const identity: HarnessProcessIdentity | undefined = child.pid
          ? {
              pid: child.pid,
              token: processToken,
              startedAt: new Date().toISOString(),
              group: true,
            }
          : undefined;
        // Keep the TAIL of the stream, bounded. Test runners write their
        // verdicts last; keeping the head turned run c54c2ed4's evidence into
        // mid-stream noise while `Failed: @open-mercato/core#test` was dropped.
        let chunks: Buffer[] = [];
        let total = 0;
        let droppedBytes = 0;
        let timedOut = false;
        let settled = false;
        const collect = (chunk: Buffer) => {
          chunks.push(chunk);
          total += chunk.length;
          if (total > OP_OUTPUT_CAP * 2) {
            const joined = Buffer.concat(chunks);
            const kept = joined.subarray(joined.length - OP_OUTPUT_CAP);
            droppedBytes += joined.length - kept.length;
            chunks = [kept];
            total = kept.length;
          }
        };
        const snapshot = (): { text: string; dropped: number } => {
          const joined = Buffer.concat(chunks);
          const kept =
            joined.length > OP_OUTPUT_CAP
              ? joined.subarray(joined.length - OP_OUTPUT_CAP)
              : joined;
          return {
            text: kept.toString('utf8'),
            dropped: droppedBytes + (joined.length - kept.length),
          };
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const abort = () => terminateProcessTree(child, identity);
        opts.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child, identity);
        }, timeoutMs);
        timer.unref?.();
        const settle = (code: number | null, syntheticOutput?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', abort);
          opts.onExit?.(command, index);
          const captured = snapshot();
          resolve({
            code,
            output: syntheticOutput ?? captured.text,
            droppedBytes: syntheticOutput ? 0 : captured.dropped,
            timedOut,
          });
        };
        try {
          if (identity) opts.onSpawn?.(identity, command, index);
        } catch (error) {
          terminateProcessTree(child, identity);
          settle(
            null,
            `failed to persist validation process identity: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        child.on('error', (err) => {
          settle(null, `failed to spawn: ${err.message}`);
        });
        child.on('close', (code) => {
          settle(code);
        });
      });
      opts.onOutput?.(command, result.output);
      const passed = result.code === 0 && !result.timedOut;
      if (!passed) failed = true;
      let logPath: string | undefined;
      if (opts.logDir) {
        try {
          const slug =
            command
              .replace(/[^a-zA-Z0-9._-]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 60) || 'command';
          const prefix = (opts.logPrefix ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-');
          logPath = join(opts.logDir, `${prefix}${index + 1}-${slug}.log`);
          const banner =
            result.droppedBytes > 0
              ? `[cezar: output exceeded the capture cap — first ${result.droppedBytes} bytes dropped, tail kept]\n`
              : '';
          writeFileSync(logPath, banner + result.output, 'utf8');
        } catch {
          logPath = undefined; // an unwritable log never fails the gate itself
        }
      }
      if (passed) {
        const tail = result.output.trim().split('\n').slice(-8).join('\n');
        checks.push({
          command,
          status: 'passed',
          exitCode: result.code,
          evidence: tail || '(no output)',
          ...(logPath ? { logPath } : {}),
        });
      } else {
        const notes = [
          result.timedOut
            ? `command timed out after ${
                timeoutMs >= 120_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${timeoutMs / 1000}s`
              } and was killed`
            : null,
          result.droppedBytes > 0
            ? `output exceeded the ${OP_OUTPUT_CAP}-byte capture cap — kept the tail, dropped ${result.droppedBytes} earlier bytes`
            : null,
        ].filter((note): note is string => note !== null);
        const extracted = extractFailureEvidence(result.output);
        checks.push({
          command,
          status: 'failed',
          exitCode: result.code,
          evidence: [
            ...notes,
            extracted || '(no output)',
            ...(logPath ? [`full output: ${logPath}`] : []),
          ].join('\n'),
          failureIds: extractFailingTestIds(result.output),
          ...(logPath ? { logPath } : {}),
          ...(result.timedOut ? { timedOut: true } : {}),
        });
      }
    }
  } finally {
    if (corepackShimDir) {
      rmSync(corepackShimDir, { recursive: true, force: true });
    }
  }
  return checks;
}
