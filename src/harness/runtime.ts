import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
 *  so after materialization this is simply a path probe. */
export function resolveHarnessScript(cwd: string): string | null {
  const path = join(cwd, '.claude', 'skills', 'cez-harness', 'scripts', 'harness.mjs');
  return existsSync(path) ? path : null;
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
    this.current?.kill('SIGTERM');
  }

  run(
    op: string,
    args: string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<HarnessOpResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const child = spawn(process.execPath, [this.opts.script, op, ...args], {
        cwd: this.opts.cwd,
        env: { ...process.env, ...this.opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.current = child;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Escalate if SIGTERM is ignored — the watchdog pattern the CLI
        // runners use.
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
      }, timeoutMs);
      timer.unref?.();
      const collect = (sink: 'out' | 'err') => (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (sink === 'out' && stdout.length < OP_OUTPUT_CAP) stdout += text;
        if (sink === 'err' && stderr.length < OP_OUTPUT_CAP) stderr += text;
      };
      child.stdout?.on('data', collect('out'));
      child.stderr?.on('data', collect('err'));
      const settle = (result: Omit<HarnessOpResult, 'durationMs'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.current = null;
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

/** Read the worktree's `.ai/agentic.config.json` — the om pipeline's config,
 *  which cezar reads and never writes. Missing/invalid degrades to defaults. */
export async function loadAgenticConfig(cwd: string): Promise<AgenticConfig> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, '.ai', 'agentic.config.json'), 'utf8'));
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
  opts: { timeoutMs?: number; onOutput?: (command: string, text: string) => void } = {},
): Promise<HarnessValidationCheck[]> {
  const checks: HarnessValidationCheck[] = [];
  let failed = false;
  for (const command of commands) {
    if (failed) {
      checks.push({ command, status: 'skipped', exitCode: null, evidence: 'skipped — a previous command failed' });
      continue;
    }
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn('bash', ['-lc', command], { cwd, env: process.env });
      let output = '';
      const collect = (chunk: Buffer) => {
        if (output.length < OP_OUTPUT_CAP) output += chunk.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? VALIDATION_TIMEOUT_MS);
      timer.unref?.();
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: null, output: `failed to spawn: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
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
  return checks;
}
