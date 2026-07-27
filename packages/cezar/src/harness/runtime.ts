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
/** Validation commands are repo test suites — give them a long leash. */
const VALIDATION_TIMEOUT_MS = 30 * 60_000;
const PROCESS_KILL_GRACE_MS = 5_000;

/** Environment inherited by the deterministic harness and the provider CLIs it launches.
 * The server process may carry unrelated deployment/database credentials; forwarding all of
 * `process.env` to independent reviewer processes turns a read-only review into secret access.
 * Provider-specific names are added explicitly from trusted `agentHarness` configuration. */
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
  // Subscription CLIs commonly use their standard credential variables even
  // without an agentHarness model entry. These are provider credentials, not
  // arbitrary server secrets.
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

/** Every harness/validation child is its own process-group leader on Unix.
 * Signals target that group so provider CLIs and shell grandchildren cannot
 * outlive the run. Windows uses taskkill's documented tree mode. */
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
        // The process already exited.
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
    // The ChildProcess object retains its pid after close. Never aim a delayed
    // hard-kill at that stale number: the OS may already have assigned it to
    // an unrelated process/group.
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

/** Check the random token in the process environment before touching a recorded PID. PID reuse
 * must never turn harness recovery into a kill of an unrelated local process. */
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
    // The owned process already exited.
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
  // Re-check immediately before escalation; the PID may have exited and been
  // reused during the grace window.
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
  /** Spawn/timeout diagnostics — set only when the op never ran or was cut off. */
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

/**
 * Copy a tree resolving EVERY symlink to its contents.
 *
 * `cpSync(..., { dereference: true })` does not do this for a symlinked
 * DIRECTORY at the root of a recursive copy — the sealed tree kept pointing at
 * the mutable original, which is precisely the escape sealing exists to close
 * (a `team`-sourced skill materializes as exactly such a link). Walk it
 * explicitly instead, so the seal is by value at every level.
 */
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
  /** The `cez-harness` collection resolves AND its runtime script is real. */
  installed: boolean;
  source: Skill['source'] | null;
  /** The pinned upstream commit — vendor MANIFEST for `bundled`, the resolved
   *  repo commit for `team`; null where provenance is unrecorded (local dirs). */
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
    // Team skills materialize from the bare clone at run time; the catalog
    // hit itself proves the clone is readable.
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

  /** Terminate the in-flight op (the cancel path). Ops are serial — the
   *  driver awaits each one — so one handle suffices. */
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

/* ------------------------------------------------------------------ */
/* Trusted configuration                                               */
/* ------------------------------------------------------------------ */

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
  // Dash-guard: `baseRef` is spliced in as a git operand.
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

/* ------------------------------------------------------------------ */
/* Validation gate                                                     */
/* ------------------------------------------------------------------ */

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
      const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
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
        let output = '';
        let settled = false;
        const collect = (chunk: Buffer) => {
          if (output.length < OP_OUTPUT_CAP) {
            output += chunk.toString('utf8').slice(0, OP_OUTPUT_CAP - output.length);
          }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        const abort = () => terminateProcessTree(child, identity);
        opts.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(
          () => terminateProcessTree(child, identity),
          opts.timeoutMs ?? VALIDATION_TIMEOUT_MS,
        );
        timer.unref?.();
        const settle = (code: number | null, resultOutput: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', abort);
          opts.onExit?.(command, index);
          resolve({ code, output: resultOutput });
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
          settle(code, output);
        });
      });
      opts.onOutput?.(command, result.output);
      const passed = result.code === 0;
      if (!passed) failed = true;
      const tail = result.output.trim().split('\n').slice(-8).join('\n');
      checks.push({
        command,
        status: passed ? 'passed' : 'failed',
        exitCode: result.code,
        evidence: tail || '(no output)',
      });
    }
  } finally {
    if (corepackShimDir) {
      rmSync(corepackShimDir, { recursive: true, force: true });
    }
  }
  return checks;
}
