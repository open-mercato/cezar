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
 *   1. **Isolation** — each run gets a hashed project directory under
 *      `<cezarHomeDir>/tmp/agent`, outside the repository and away from an
 *      inherited checkout-local `TMPDIR`, reaped when the run ends.
 *      `buildChildEnv` applies the per-run env last, so these values win over
 *      the host's without any allowlist change. Isolation is from other *users*
 *      too: the tree is owner-only, and the platform-temp fallback root — a
 *      fixed path in a world-writable directory — is vetted before use.
 *   2. **Fail loud** — the directory is write-probed before the backend spawns.
 *      A run that cannot get a working temp directory fails immediately with a
 *      named, actionable error instead of spawning an agent that will run blind.
 *
 * `CEZ_AGENT_TMPDIR=0` opts out of BOTH — cezar keeps its hands off the temp
 * directory entirely and the pre-#785 behaviour is back, byte for byte. That is
 * deliberate: an escape hatch that still imposed the preflight would be a hatch
 * you cannot actually escape through, and this repo's graceful-degradation rule
 * says a new check must never become the only way to run.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cezarHomeDir } from '../paths.ts';

/** Owner-only, for every directory and file this module creates.
 *
 *  Not belt-and-braces: the tree below is the agent's entire `TMPDIR`, and the
 *  Claude backend round-trips each `Bash` command's stdout and stderr through a
 *  file in it (see the module header). At the default mode that is world-readable,
 *  and under the platform-temp fallback it sits in a directory every local user
 *  can write to. `0o700`/`0o600` survive any usual umask — a umask only clears
 *  bits — so this is the mode, not a request for one. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Run ids are uuids; anything else must never reach a recursive `rmSync`.
 *
 *  `.` and `..` are excluded explicitly, not as pedantry: they match the
 *  character class, and relative traversal would otherwise escape the run's
 *  scratch namespace. A guard that admits an input capable of turning this
 *  helper into data loss is not a guard. */
function safeRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/** Where a run's agent-scoped temp directory lives, outside project state. */
function projectTmpNamespace(dataDir: string): string {
  return createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
}

function effectiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Read the platform temp root without inheriting a checkout-local temp override. */
function platformTmpDir(): string {
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  delete process.env.TMPDIR;
  delete process.env.TEMP;
  delete process.env.TMP;
  try {
    return tmpdir();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Find the checkout containing dataDir; linked worktrees have a .git file. */
function containingCheckoutRoot(dataDir: string): string | undefined {
  let current = resolve(dataDir);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The last-resort base, used when CEZ_HOME would put scratch inside the checkout. */
function platformFallbackBase(): string {
  return join(platformTmpDir(), 'cez-agent');
}

/** Prefer CEZ_HOME, but never place agent scratch inside the checkout it protects. */
function agentTmpBase(dataDir: string, env: NodeJS.ProcessEnv): string {
  const preferred = join(cezarHomeDir(env), 'tmp', 'agent');
  const checkout = containingCheckoutRoot(dataDir);
  if (!isInside(checkout ?? dataDir, preferred)) return preferred;
  return platformFallbackBase();
}

/**
 * Make `base` private before anything is written beneath it — the guard the
 * platform-temp fallback needs and `~/.cezar` does not.
 *
 * `<platform tmp>/cez-agent` is a fixed path in a directory every local user can
 * write to, so it is the first thing a hostile local user pre-creates: as a
 * symlink into a directory they read, or as a directory of their own. Everything
 * under it is the agent's `TMPDIR`, which carries every command's output. So:
 * create it owner-only, re-tighten a loose one that is ours, and refuse — rather
 * than follow — a symlink or a directory somebody else owns.
 *
 * Exported for the tests, which must exercise it on a base of their own:
 * `platformTmpDir()` is deliberately not env-overridable.
 */
export function securePrivateDir(base: string): void {
  try {
    mkdirSync(base, { recursive: true, mode: PRIVATE_DIR_MODE });
    const stat = lstatSync(base);
    if (!stat.isDirectory()) {
      throw new Error('not a directory — refusing to follow it');
    }
    // Windows has no uid and no meaningful mode bits; there is nothing to check.
    const uid = process.getuid?.();
    if (uid === undefined) return;
    if (stat.uid !== uid) {
      throw new Error(`owned by uid ${stat.uid}, not ${uid} — refusing to write agent scratch into it`);
    }
    if ((stat.mode & 0o077) !== 0) chmodSync(base, PRIVATE_DIR_MODE);
  } catch (err) {
    throw new AgentTempDirError(base, err, 'remove or take ownership of that path');
  }
}

export function agentTmpDir(dataDir: string, runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(agentTmpBase(dataDir, effectiveEnv(env)), projectTmpNamespace(dataDir), runId);
}

/** The root every per-run directory hangs off — the only scratch tree this module removes. */
function agentTmpRoot(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(agentTmpBase(dataDir, effectiveEnv(env)), projectTmpNamespace(dataDir));
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
 *
 * `remedy` is the one thing the reader is supposed to go and do, and it is not
 * always "free disk space": the fallback-root guard rejects a directory that is
 * perfectly writable and simply is not ours, and sending that reader to check
 * their disk wastes the one actionable sentence they get.
 */
export class AgentTempDirError extends Error {
  readonly path: string;

  constructor(path: string, reason: unknown, remedy = 'free disk space') {
    const code = (reason as NodeJS.ErrnoException | undefined)?.code;
    const why = (code && REASONS[code])
      ?? code
      ?? (reason instanceof Error ? reason.message : String(reason));
    super(
      `agent temp directory is not writable: ${path} (${why}) — ${remedy}, `
        + 'or set CEZ_AGENT_TMPDIR=0 to fall back to the host TMPDIR',
    );
    this.name = 'AgentTempDirError';
    this.path = path;
  }
}

/** Opt-out spelling matches the house style for default-on behaviour
 *  (`CEZ_AUTONAME=0`, `CEZ_SKILLS_AUTO_UPDATE=0`): only an exact `0` disables. */
export function agentTmpDirEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AGENT_TMPDIR !== '0';
}

/** Distinguishes concurrent probes from one process; the pid alone would let two
 *  spawns racing on the same directory delete each other's file mid-probe. */
let probeSeq = 0;

/**
 * Write-probe `dir`. Creating the file is not enough to prove the directory
 * works — a quota-exhausted tmpfs still allocates the inode and only fails the
 * `write(2)` — so the probe writes real bytes and removes them again. A
 * directory that is merely *full but writable* passes, by design.
 */
function probeWritable(dir: string): void {
  const probe = join(dir, `.cez-tmp-probe-${process.pid}-${(probeSeq += 1)}`);
  try {
    writeFileSync(probe, 'cez', { mode: PRIVATE_FILE_MODE });
  } catch (err) {
    throw new AgentTempDirError(dir, err);
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
 * Returns `{}` under the opt-out, without probing anything: the hatch turns the
 * whole feature off, preflight included, so it stays an escape someone can
 * actually take.
 */
export function agentTmpEnv(
  dataDir: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!agentTmpDirEnabled(env)) return {};
  const dir = agentTmpDir(dataDir, runId, env);
  // Only the shared fallback needs vetting; `~/.cezar` is already the user's own.
  const fallback = platformFallbackBase();
  if (isInside(fallback, dir)) securePrivateDir(fallback);
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (err) {
    throw new AgentTempDirError(dir, err);
  }
  probeWritable(dir);
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/**
 * Reap one run's directory. Scratch, not an artifact: nothing reads it once the
 * agent is gone, and a Continue re-creates it through `agentTmpEnv`. Never
 * throws — reaping must not break a terminal transition.
 */
export function removeAgentTmpDir(dataDir: string, runId: string): void {
  if (!safeRunId(runId)) return;
  try {
    rmSync(agentTmpDir(dataDir, runId), { recursive: true, force: true });
  } catch {
    // best-effort; the startup sweep picks up whatever survives.
  }
}

/**
 * Remove every per-run directory that is not in `keepRunIds` — the startup
 * sweep, so a crash (which never reaches the terminal-transition reap) cannot
 * accumulate them forever. Confined to this project's hashed scratch root;
 * project run state is never enumerated, let alone touched. Returns the ids reaped.
 */
export function sweepAgentTmpDirs(dataDir: string, keepRunIds: Iterable<string>, env: NodeJS.ProcessEnv = process.env): string[] {
  const root = agentTmpRoot(dataDir, env);
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
    if (keep.has(name) || !safeRunId(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      reaped.push(name);
    } catch {
      // best-effort: a locked directory is retried on the next boot.
    }
  }
  return reaped;
}
