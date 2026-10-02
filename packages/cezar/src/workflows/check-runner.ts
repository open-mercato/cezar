/**
 * The ONE seam that executes a check command — the `command:` half of a
 * workflow step, and the primitive the landing check will call for every
 * command of a gate.
 *
 * Why it exists: the check-step executor this replaces (`runCheckStep` before
 * #S1) was four lines of `spawn('bash', ['-lc', command], { env: process.env })`
 * with no wall clock, a `child.kill('SIGTERM')` that reached only the direct
 * pid, and a head-kept 20k output cap. Any of those is a way for an unattended
 * gate to hang a `maxParallel` slot forever, leave orphaned grandchildren, or
 * hand a repository's own script every credential cezar holds. The rules below
 * are deliberately dumb and testable; a caller with unusual needs passes the
 * option instead of re-implementing the spawn.
 *
 * What this is NOT: a sandbox. A check runs repository code, by design, as the
 * local user — see `buildCheckEnv` for the one part of the blast radius this
 * module does reduce (the environment), and `docs/reference.md` for the honest
 * statement of what a check can still reach (files, `gh`, ssh).
 *
 * Every exit is a `CheckOutcomeStatus`, and exactly one of them (`passed`) is
 * green: a timeout, a cancellation, a platform that cannot run a POSIX process
 * group and a dry run are all visibly NOT success. "It did not run" must never
 * read as "it passed" — that is the whole point of the status union.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildCheckEnv } from '../core/agent-env.ts';

/** Per-command wall clock: 20 minutes. Long enough for a real test suite, short
 *  enough that a hung command cannot hold a `maxParallel` slot for a night. */
export const CHECK_COMMAND_TIMEOUT_MS = 20 * 60_000;
/** Whole-gate deadline: 45 minutes. Bounds the SUM of a gate's commands, so a
 *  workflow that loops back into its checks (or a gate with a dozen commands)
 *  cannot stay "running" for hours of retries. */
export const CHECK_GATE_TIMEOUT_MS = 45 * 60_000;
/** SIGTERM → SIGKILL grace for the whole process group. A command that ignores
 *  SIGTERM (or whose child does) still ends, and the pipes still close. */
export const CHECK_TERMINATE_GRACE_MS = 5_000;
/** How much of a command's transcript is kept, and which END is kept: the tail.
 *  A failing command says WHY at the end (`npm test` prints its summary last),
 *  so the old head-kept cap threw away the one line the retried agent needed. */
export const CHECK_OUTPUT_CAP = 20_000;

/** Marker line placed before the retained tail. The elided count is the whole
 *  point: a reviewer can see that a transcript was cut, and by how much. */
export function checkTruncationMarker(elidedChars: number): string {
  return `… (${elidedChars} characters elided at the head — the tail is kept)`;
}

/**
 * Tail-preserving cap. `totalChars` is the FULL transcript length when the
 * caller streamed the output through a rolling buffer; it defaults to the
 * length of `text` for a direct call.
 */
export function capCheckOutput(text: string, cap = CHECK_OUTPUT_CAP, totalChars?: number): string {
  const total = totalChars ?? text.length;
  if (total <= cap) return text;
  const tail = text.length > cap ? text.slice(-cap) : text;
  return `${checkTruncationMarker(Math.max(0, total - cap))}\n${tail}`;
}

/**
 * Every way a check command can end. ONLY `passed` is green — callers must
 * branch on the status, never on "did it not throw".
 *
 *  - `passed`       — exited 0. The one success.
 *  - `failed`       — exited non-zero, or was killed by a signal we did not send.
 *  - `timed-out`    — the per-command limit or the gate deadline fired; the
 *                     process group was killed. NON-GREEN.
 *  - `cancelled`    — the run was cancelled (or interrupted); group killed. NON-GREEN.
 *  - `could-not-run`— win32, no `bash`, or a spawn error: nothing ran. NON-GREEN.
 *  - `skipped`      — `CEZ_DRY_RUN=1`: nothing ran on purpose. NON-GREEN.
 */
export type CheckOutcomeStatus =
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'cancelled'
  | 'could-not-run'
  | 'skipped';

export interface CheckOutcome {
  status: CheckOutcomeStatus;
  /** `status === 'passed'` — the single green predicate, spelled out so no
   *  caller has to remember which of six statuses counts as success. */
  ok: boolean;
  /** The command's exit code, or `-1` when nothing ran / it did not exit itself. */
  exitCode: number;
  /** The capped transcript (stdout+stderr interleaved) with, for every
   *  non-green status, a final line saying why. Never empty. */
  output: string;
  /** One-line reason for a non-green status; undefined for passed/failed. */
  reason?: string;
  /** Wall clock the command (or the nothing that ran) took. */
  durationMs: number;
}

export interface CheckCommandOptions {
  /** Where the command runs — the task worktree, or the landing check's scratch tree. */
  cwd: string;
  /** The shell command line, handed to `bash -c` verbatim. */
  command: string;
  /** Child environment; defaults to `buildCheckEnv()` — the minimal one, and the
   *  only place the env policy lives, so a new caller inherits it by omission. */
  env?: NodeJS.ProcessEnv;
  /** Per-command wall clock in ms; `0` disables it. Default `CHECK_COMMAND_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Absolute epoch-ms deadline for the whole gate; the effective limit is
   *  whichever of this and `timeoutMs` comes first. */
  gateDeadlineAt?: number;
  /** SIGTERM → SIGKILL grace, ms. Default `CHECK_TERMINATE_GRACE_MS`. */
  graceMs?: number;
  /** Output cap in characters (tail kept). Default `CHECK_OUTPUT_CAP`. */
  cap?: number;
  /** `CEZ_DRY_RUN=1` semantics: spawn nothing, report `skipped`. Default: the env. */
  dryRun?: boolean;
  /** Default: `process.platform`. win32 is a deterministic `could-not-run`. */
  platform?: NodeJS.Platform;
  /** Resolve the shell (POSIX `bash`); `undefined` = cannot run. Injectable so a
   *  test can prove the missing-shell path without touching the real PATH. */
  resolveShell?: (env: NodeJS.ProcessEnv) => string | undefined;
  /** Interrupt/cancellation. Aborting kills the whole process group and resolves
   *  with `cancelled` — the promise ALWAYS settles. */
  signal?: AbortSignal;
  /** Live output tap (uncapped). The workflow transcript is emitted once, at the
   *  end, by the caller; this is for a caller that wants to stream. */
  onOutput?: (chunk: string) => void;
}

/** `CEZ_DRY_RUN=1` means "spawn nothing". Read here so a check is dry-run aware
 *  even when its caller forgets to pass anything. */
export function checkDryRunEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.CEZ_DRY_RUN === '1';
}

/** Case-insensitive env read — Windows spells it `Path`. */
function readEnvVar(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = source[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(source)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/**
 * Resolve `bash` on the child's own PATH. Probing beats spawning: a missing
 * shell is then a recorded `could-not-run` in under a millisecond instead of an
 * ENOENT racing the command's first output.
 */
export function resolveBash(env: NodeJS.ProcessEnv): string | undefined {
  const path = readEnvVar(env, 'PATH');
  if (!path) return undefined;
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'bash');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not there, or not executable — the next PATH entry gets its turn
    }
  }
  return undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Run ONE check command and report a `CheckOutcome`. Never throws: a failure to
 * run is an outcome, not an exception, because every caller has to record it.
 *
 * Discipline, in one place so no caller repeats it:
 *  - detached spawn → the command leads its own process group;
 *  - termination is a GROUP signal (SIGTERM to `-pid`), a `graceMs` wait, then
 *    SIGKILL — on timeout, on abort, and once the leader exits (so a command
 *    that backgrounded something cannot hold the pipes, or the tree, open);
 *  - `bash --noprofile --norc -c` — no login shell reading a profile that
 *    re-adds what the environment cut took out;
 *  - the transcript keeps its TAIL, with an explicit elision marker.
 */
export async function runCheckCommand(options: CheckCommandOptions): Promise<CheckOutcome> {
  const startedAt = Date.now();
  const cap = options.cap ?? CHECK_OUTPUT_CAP;
  const graceMs = options.graceMs ?? CHECK_TERMINATE_GRACE_MS;
  const dryRun = options.dryRun ?? checkDryRunEnabled();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? buildCheckEnv();

  const nothing = (status: CheckOutcomeStatus, reason: string): CheckOutcome => ({
    status,
    ok: false,
    exitCode: -1,
    output: reason,
    reason,
    durationMs: Date.now() - startedAt,
  });

  if (options.signal?.aborted) return nothing('cancelled', 'cancelled before the command started');
  if (dryRun) {
    // Spawns nothing, by contract: `CEZ_DRY_RUN=1` is the offline look-around, and
    // a check is repository code. The skip is visible and NOT green.
    return nothing('skipped', 'skipped (CEZ_DRY_RUN=1) — nothing was run');
  }
  if (platform === 'win32') {
    return nothing(
      'could-not-run',
      'could not run: a check needs a POSIX shell and process group, neither of which this platform provides',
    );
  }
  const resolveShell = options.resolveShell ?? resolveBash;
  const shell = resolveShell(env);
  if (!shell) return nothing('could-not-run', 'could not run: no bash on PATH');

  // Effective limit: the sooner of the per-command limit and the gate deadline.
  const now = Date.now();
  const perCommand = options.timeoutMs ?? CHECK_COMMAND_TIMEOUT_MS;
  const gateLimit = options.gateDeadlineAt === undefined ? undefined : options.gateDeadlineAt - now;
  const commandLimit = perCommand === 0 ? undefined : perCommand;
  const gateWins = gateLimit !== undefined && (commandLimit === undefined || gateLimit <= commandLimit);
  const limitMs: number | undefined = gateWins ? gateLimit : commandLimit;
  /** The line a timed-out command leaves behind — which clock fired matters. */
  const timeoutReason = (): string =>
    gateWins
      ? 'timed out: the whole-gate deadline expired — killed the process group'
      : `timed out after ${formatDuration(limitMs ?? 0)} — killed the process group`;
  if (limitMs !== undefined && limitMs <= 0) {
    return nothing('timed-out', `timed out: the gate deadline had already expired — nothing was run`);
  }

  return await new Promise<CheckOutcome>((resolve) => {
    let output = '';
    let totalChars = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let limitTimer: NodeJS.Timeout | undefined;

    const child = spawn(shell, ['--noprofile', '--norc', '-c', options.command], {
      cwd: options.cwd,
      env,
      // Its own process group: the only handle that reaches a grandchild.
      detached: true,
      // A check has no conversation to hold open — stdin is /dev/null, so a
      // command that reads it sees EOF instead of hanging on our pipes.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    /** Is anything at all still in the child's process group? */
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        // Signal 0 asks the question without delivering anything.
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false; // ESRCH: the whole group is gone
      }
    };

    /** SIGTERM the whole group, then SIGKILL it if it is still there after the grace. */
    const terminateGroup = (): void => {
      if (child.pid === undefined || !groupAlive()) return;
      const pgid = child.pid;
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {
        // already gone (ESRCH) — nothing to terminate
      }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, graceMs);
      killTimer.unref?.();
    };

    const cleanup = (): void => {
      if (limitTimer) clearTimeout(limitTimer);
      // The SIGKILL escalation is the only promise still owed to a process group
      // that outlived its leader: drop it only once the group is VERIFIABLY
      // empty. Clearing it here unconditionally is what let a SIGTERM-ignoring
      // grandchild survive the old runner.
      if (killTimer && !groupAlive()) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      options.signal?.removeEventListener('abort', onAbort);
    };

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      totalChars += text.length;
      output += text;
      // Rolling window so a chatty command cannot grow memory without bound; the
      // final cap keeps the last `cap` characters (plus the marker).
      if (output.length > cap * 2) output = output.slice(-cap * 2);
      options.onOutput?.(text);
    };

    const settle = (status: CheckOutcomeStatus, exitCode: number, reason?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const transcript = capCheckOutput(output.trim(), cap, totalChars);
      const lines = [transcript, reason].filter((line): line is string => Boolean(line));
      resolve({
        status,
        ok: status === 'passed',
        exitCode,
        output: lines.length ? lines.join('\n') : '(no output)',
        ...(reason ? { reason } : {}),
        durationMs: Date.now() - startedAt,
      });
    };

    function onAbort(): void {
      cancelled = true;
      terminateGroup();
    }

    if (limitMs !== undefined) {
      limitTimer = setTimeout(() => {
        timedOut = true;
        terminateGroup();
      }, Math.max(1, limitMs));
      limitTimer.unref?.();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', (err) => {
      settle('could-not-run', -1, `could not run: failed to spawn: ${err.message}`);
    });

    child.on('exit', () => {
      // The leader is gone; anything still in its group is an orphan that would
      // otherwise hold the pipes (and the tree) for as long as it likes.
      terminateGroup();
    });

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle('timed-out', -1, timeoutReason());
        return;
      }
      if (cancelled) {
        settle('cancelled', -1, 'cancelled — killed the process group');
        return;
      }
      if (code === null && signal) {
        settle('failed', -1, `terminated by signal ${signal}`);
        return;
      }
      if (code === null) {
        settle('could-not-run', -1, 'could not run: the shell produced no exit status');
        return;
      }
      settle(code === 0 ? 'passed' : 'failed', code);
    });
  });
}
