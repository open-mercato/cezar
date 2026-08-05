/**
 * Task-scoped temp directory for spawned agents (#785).
 *
 * Every agent used to inherit the host's `TMPDIR`/`TEMP`/`TMP` verbatim — they
 * ride in on `buildChildEnv`'s base allowlist — so every run on the machine
 * shared one directory. On a box that runs agents continuously and never
 * reboots, that directory is a tmpfs nobody reaps, and once it hits its quota
 * the failure is *silent*: the Claude Code CLI roots its scratch tree at
 * `os.tmpdir()` and round-trips each `Bash` command's stdout/stderr through a
 * file there. Under `EDQUOT` the inode is still allocated, so the file is
 * created and the write fails — the command runs, its side effects land, and
 * the agent reads back an empty result with a bogus exit status. Nothing in the
 * cockpit says anything is wrong.
 *
 * Two properties fix that, and this module owns both:
 *
 *   1. **Isolation** — each run gets `<dataDir>/tmp/<runId>`, on the same disk
 *      as the run's own state rather than a shared tmpfs, reaped when the run
 *      ends. `buildChildEnv` applies the per-run env last, so these values win
 *      over the host's without any allowlist change.
 *   2. **Fail loud** — the directory is write-probed before the backend spawns.
 *      A run that cannot get a working temp directory fails immediately with a
 *      named, actionable error instead of spawning an agent that will run blind.
 *
 * `CEZ_AGENT_TMPDIR=0` opts out and restores the host `TMPDIR` (the preflight
 * still runs — a broken temp directory is worth reporting either way).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run ids are uuids; anything else must never reach a recursive `rmSync`. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

/** Where a run's agent-scoped temp directory lives. */
export function agentTmpDir(dataDir: string, runId: string): string {
  return join(dataDir, 'tmp', runId);
}

/** The root every per-run directory hangs off — the ONLY tree this module
 *  removes anything from (`runs/`, `runs.json` and `worktrees/` are siblings). */
export function agentTmpRoot(dataDir: string): string {
  return join(dataDir, 'tmp');
}

/** `errno` → the phrasing a human recognises from their shell. */
const REASONS: Readonly<Record<string, string>> = {
  EDQUOT: 'Disk quota exceeded',
  ENOSPC: 'No space left on device',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EROFS: 'Read-only file system',
};

/**
 * The preflight's failure. Named so the spawn path can tell it apart from an
 * ordinary crash and turn it into the run's `error` — the same treatment
 * `ModelIdentityError` gets, and the same channel the thread footer renders.
 */
export class AgentTempDirError extends Error {
  readonly path: string;

  constructor(path: string, reason: unknown, hostTmp: boolean) {
    const code = (reason as NodeJS.ErrnoException | undefined)?.code;
    const why = (code && REASONS[code])
      ?? code
      ?? (reason instanceof Error ? reason.message : String(reason));
    const remedy = hostTmp
      ? 'free disk space or point TMPDIR somewhere writable'
      : 'free disk space, or set CEZ_AGENT_TMPDIR=0 to fall back to the host TMPDIR';
    super(`agent temp directory is not writable: ${path} (${why}) — ${remedy}`);
    this.name = 'AgentTempDirError';
    this.path = path;
  }
}

/** Opt-out spelling matches the house style for default-on behaviour
 *  (`CEZ_AUTONAME=0`, `CEZ_SKILLS_AUTO_UPDATE=0`): only an exact `0` disables. */
export function agentTmpDirEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AGENT_TMPDIR !== '0';
}

/**
 * Create + write-probe `dir`. Creating the file is not enough to prove the
 * directory works — a quota-exhausted tmpfs still allocates the inode and only
 * fails the `write(2)` — so the probe writes real bytes and removes them again.
 * A directory that is merely *full but writable* passes, by design.
 */
function probeWritable(dir: string, hostTmp: boolean): void {
  const probe = join(dir, `.cez-tmp-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'cez');
  } catch (err) {
    throw new AgentTempDirError(dir, err, hostTmp);
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // best-effort: a probe we could not remove is not a reason to fail a run.
    }
  }
}

/**
 * The `TMPDIR`/`TEMP`/`TMP` overrides for this run, after proving the resolved
 * directory actually accepts writes. Throws `AgentTempDirError` when it does
 * not — callers turn that into the run's error rather than spawning.
 *
 * All three spellings are set, on every platform: a tool that reads `TMP` (or
 * `TEMP`) would otherwise keep following the host value straight back to the
 * exhausted directory this exists to escape.
 *
 * Returns `{}` under the opt-out — the host `TMPDIR` stays in force, and is
 * probed instead so the failure is still reported rather than discovered
 * through empty command output.
 */
export function agentTmpEnv(
  dataDir: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!agentTmpDirEnabled(env)) {
    probeWritable(env.TMPDIR ?? env.TEMP ?? env.TMP ?? tmpdir(), true);
    return {};
  }
  const dir = agentTmpDir(dataDir, runId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new AgentTempDirError(dir, err, false);
  }
  probeWritable(dir, false);
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/**
 * Reap one run's directory. Scratch, not an artifact: nothing reads it once the
 * agent is gone, and a Continue re-creates it through `agentTmpEnv`. Never
 * throws — reaping must not break a terminal transition.
 */
export function removeAgentTmpDir(dataDir: string, runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) return;
  try {
    rmSync(agentTmpDir(dataDir, runId), { recursive: true, force: true });
  } catch {
    // best-effort; the startup sweep picks up whatever survives.
  }
}

/**
 * Remove every per-run directory that is not in `keepRunIds` — the startup
 * sweep, so a crash (which never reaches the terminal-transition reap) cannot
 * accumulate them forever. Confined to `<dataDir>/tmp`; sibling run state is
 * never enumerated, let alone touched. Returns the ids actually reaped.
 */
export function sweepAgentTmpDirs(dataDir: string, keepRunIds: Iterable<string>): string[] {
  const root = agentTmpRoot(dataDir);
  if (!existsSync(root)) return [];
  const keep = new Set(keepRunIds);
  const reaped: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (keep.has(name) || !SAFE_RUN_ID.test(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      reaped.push(name);
    } catch {
      // best-effort: a locked directory is retried on the next boot.
    }
  }
  return reaped;
}
