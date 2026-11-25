/**
 * Unclean-shutdown detection (docs/telemetry.md § "Unclean shutdowns"). A SIGKILL, an OOM kill or
 * a crash in native code ends the process before any handler runs, so the process that died can
 * never say so: on 2026-11-25 the desktop app was SIGKILLed twice and nothing was reported.
 *
 * Each `serve` keeps a marker, `~/.cezar/telemetry/live/<pid>-<host>.json`, refreshed every minute
 * and removed on every exit Node gets to see. The next `serve` finds a marker whose process is gone
 * and reports it — consent permitting — with what the marker and the desktop shell's
 * `~/.cezar/logs/cockpit.log` (#2489) say about it: facts only, never output text or paths.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, uptime as hostUptime } from 'node:os';
import { join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from './paths.ts';
import { reportError, type ContextValue } from './telemetry.ts';

const BEAT_MS = 60_000;
/** A marker this old under a live pid is a pid reused by something else: dropped unreported. */
const STALE_MS = 30 * 86_400_000;
/** Another host's (container's) marker cannot be probed by pid: silent this long means dead. */
const FOREIGN_STALE_MS = 10 * BEAT_MS;
/** How much of the cockpit log's end is read for the dead process's lifecycle lines. */
const LOG_TAIL_BYTES = 64 * 1024;
const MARKER_NAME = /^(\d+)-([0-9a-f]{12})\.json$/;
const RUNTIMES = new Set(['app', 'cli']);

export interface LiveMarker {
  pid: number;
  /** Hash of the hostname: containers sharing `~/.cezar` see each other's pids as dead. */
  host: string;
  startedAt: number;
  beatAt: number;
  /** The exact build, for context. */
  version: string;
  /** The telemetry `version` that build reported under; its death is filed there. */
  reportVersion: string;
  runtime: string;
  rssMb: number;
  runsRunning?: number;
}

export interface UncleanExit {
  marker: LiveMarker;
  context: Record<string, ContextValue>;
}

export function liveMarkerDir(): string {
  return join(cezarHomeDir(), 'telemetry', 'live');
}

export function cockpitLogPath(): string {
  return join(cezarHomeDir(), 'logs', 'cockpit.log');
}

export function hostId(name: string = hostname()): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 12);
}

function markerName(marker: Pick<LiveMarker, 'pid' | 'host'>): string {
  return `${marker.pid}-${marker.host}.json`;
}

/** Keep this process's marker until it exits. Never throws: a read-only home only loses detection. */
export function startLiveMarker(opts: {
  version: string;
  reportVersion: string;
  runtime: string;
  runsRunning?: () => number;
  dir?: string;
  beatMs?: number;
  host?: string;
}): () => void {
  const dir = opts.dir ?? liveMarkerDir();
  const host = opts.host ?? hostId();
  const file = join(dir, markerName({ pid: process.pid, host }));
  const startedAt = Date.now();
  const beat = () => {
    try {
      let runsRunning: number | undefined;
      try { runsRunning = opts.runsRunning?.(); } catch { /* the count is optional */ }
      const marker: LiveMarker = {
        pid: process.pid,
        host,
        startedAt,
        beatAt: Date.now(),
        version: opts.version,
        reportVersion: opts.reportVersion,
        runtime: opts.runtime,
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        ...(runsRunning === undefined ? {} : { runsRunning }),
      };
      writeFileSync(`${file}.tmp`, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch { /* best effort */ }
  };
  try {
    assertCezarHomeWriteIsSandboxed(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return () => undefined;
  }
  beat();
  const timer = setInterval(beat, opts.beatMs ?? BEAT_MS);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  };
  process.once('exit', stop);
  return stop;
}

export function parseMarker(raw: string, name: string): LiveMarker | undefined {
  try {
    const m = JSON.parse(raw) as Partial<LiveMarker>;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!Number.isInteger(m.pid) || m.pid! <= 0) return undefined;
    if (typeof m.host !== 'string' || name !== markerName({ pid: m.pid!, host: m.host })) return undefined;
    if (!num(m.startedAt) || !num(m.beatAt) || !num(m.rssMb)) return undefined;
    if (m.runsRunning !== undefined && !Number.isInteger(m.runsRunning)) return undefined;
    if (typeof m.version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(m.version)) return undefined;
    if (typeof m.reportVersion !== 'string' || !/^(\d+\.\d+\.\d+(-(nightly|pr|dev))?|unknown)$/.test(m.reportVersion)) return undefined;
    if (typeof m.runtime !== 'string' || !RUNTIMES.has(m.runtime)) return undefined;
    return m as LiveMarker;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readTail(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** `ExitStatus`'s Display on every platform; anything else is not echoed. */
const EXIT_STATUS = /^(exit status: -?\d+|exit code: -?\d+|signal: \d+(?: \(SIG[A-Z0-9]+\))?(?: \(core dumped\))?)$/;

/**
 * What the desktop shell's cockpit log (#2489) knows about the process a marker describes. Only
 * the shell's own whole-line `---` lines are matched, and they are re-written from what was
 * parsed (no entry path). The cockpit's output contributes nothing but its last timestamp.
 */
export function logFacts(tail: string, marker: Pick<LiveMarker, 'pid' | 'startedAt'>): {
  lifecycle?: string;
  lastOutputAt?: string;
  /** The shell saw the process end, or stopped it itself: not an unclean shutdown. */
  seenByShell?: boolean;
} {
  const { pid, startedAt } = marker;
  const lines = tail.split('\n').flatMap((line) => {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) (.*)$/.exec(line);
    const at = m ? Date.parse(m[1]!) : NaN;
    return m && Number.isFinite(at) ? [{ stamp: m[1]!, at, text: m[2]! }] : [];
  });
  const pidLine = `--- cockpit process pid ${pid}`;
  const ended = new RegExp(`^--- cockpit process pid ${pid} ended: (.+)$`);
  const stopped = `--- cockpit process pid ${pid} stopped by the app`;
  const starting = /^--- starting the cockpit: .* \(port (\d+)\)$/;
  // This process's span: from its own pid line (logged before it started) to the next process
  // under the same pid, so a reused pid never lends one process's ending to another.
  let from = -1;
  lines.forEach((line, i) => { if (line.text === pidLine && line.at <= startedAt) from = i; });
  let until = lines.findIndex((line) => line.text === pidLine && line.at > startedAt);
  if (until < 0) until = lines.length;
  const own = (i: number) => i < until && (from >= 0 ? i >= from : lines[i]!.at >= startedAt);

  const lifecycle: string[] = [];
  let seenByShell = false;
  let lastOutputAt: string | undefined;
  let nextStart = -1;
  if (from >= 0) {
    nextStart = lines.findIndex((line, i) => i > from && starting.test(line.text));
    const end = Math.min(nextStart < 0 ? lines.length : nextStart, until);
    lastOutputAt = lines[end - 1]?.stamp;
    if (from > 0) {
      const port = starting.exec(lines[from - 1]!.text)?.[1];
      if (port) lifecycle.push(`${lines[from - 1]!.stamp} --- starting the cockpit (port ${port})`);
    }
    lifecycle.push(`${lines[from]!.stamp} ${pidLine}`);
  }
  lines.forEach((line, i) => {
    if (!own(i)) return;
    if (line.text === stopped) {
      seenByShell = true;
      lifecycle.push(`${line.stamp} ${stopped}`);
      return;
    }
    const status = ended.exec(line.text)?.[1];
    if (status !== undefined) {
      seenByShell = true;
      lifecycle.push(`${line.stamp} ${pidLine} ended: ${EXIT_STATUS.test(status) ? status : 'other'}`);
    }
  });
  return {
    ...(lifecycle.length ? { lifecycle: lifecycle.slice(-6).join('\n') } : {}),
    ...(lastOutputAt ? { lastOutputAt } : {}),
    ...(seenByShell ? { seenByShell } : {}),
  };
}

/**
 * Claim every marker whose process is gone and return those worth reporting. A claim is a rename,
 * so two cockpits booting together report a death once. Dropped unreported: a marker from before
 * the host's last boot (power loss, a reboot — not cezar's failure), one the desktop shell saw end
 * or stopped itself (it reports its own `sidecar_killed`/`sidecar_exited`), and a malformed one.
 * Runs before this process writes its own marker, so a marker under our own pid is an earlier
 * process's (a container restarted under the same pid).
 */
export function collectUncleanExits(opts: {
  dir?: string;
  logTail?: string;
  now?: number;
  hostUptimeS?: number;
  isAlive?: (pid: number) => boolean;
  host?: string;
  selfStartedAt?: number;
  claim?: (from: string, to: string) => void;
} = {}): UncleanExit[] {
  const dir = opts.dir ?? liveMarkerDir();
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? pidAlive;
  const host = opts.host ?? hostId();
  const selfStartedAt = opts.selfStartedAt ?? Date.now() - process.uptime() * 1000;
  const claim = opts.claim ?? renameSync;
  const bootedAt = now - (opts.hostUptimeS ?? hostUptime()) * 1000;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  let tail: string | undefined = opts.logTail;
  const out: UncleanExit[] = [];
  for (const name of names) {
    const file = join(dir, name);
    // Leftovers: a write interrupted between tmp and rename, a claim whose removal failed.
    if (/\.json\.tmp$|\.claimed-\d+$/.test(name)) {
      try { rmSync(file, { force: true }); } catch { /* best effort */ }
      continue;
    }
    if (!MARKER_NAME.test(name)) continue;
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    const marker = parseMarker(raw, name);
    let report = false;
    if (marker && marker.beatAt >= bootedAt) {
      if (marker.host !== host) {
        if (now - marker.beatAt < FOREIGN_STALE_MS) continue;
        report = true;
      } else if (marker.pid === process.pid) {
        if (marker.startedAt >= selfStartedAt) continue;
        report = true;
      } else if (isAlive(marker.pid)) {
        if (now - marker.beatAt < STALE_MS) continue;
      } else {
        report = true;
      }
    }
    const claimed = `${file}.claimed-${process.pid}`;
    try { claim(file, claimed); } catch { continue; } // another cockpit claimed it
    try { rmSync(claimed, { force: true }); } catch { /* removed on a later boot */ }
    if (!report || !marker) continue;
    tail ??= readTail(cockpitLogPath(), LOG_TAIL_BYTES);
    const log = logFacts(tail, marker);
    if (log.seenByShell) continue;
    out.push({
      marker,
      context: {
        'unclean.previous_version': marker.version,
        'unclean.previous_runtime': marker.runtime,
        'unclean.uptime_s': Math.round((marker.beatAt - marker.startedAt) / 1000),
        'unclean.last_beat_age_s': Math.round((now - marker.beatAt) / 1000),
        'unclean.rss_mb': marker.rssMb,
        'unclean.foreign_host': marker.host !== host,
        ...(marker.runsRunning === undefined ? {} : { 'unclean.runs_running': marker.runsRunning }),
        ...(log.lastOutputAt ? { 'unclean.last_output_at': log.lastOutputAt } : {}),
        ...(log.lifecycle ? { 'unclean.log_lifecycle': log.lifecycle } : {}),
        'unclean.cockpit_log': tail.length > 0,
      },
    });
  }
  return out;
}

/** Report each dead cockpit, unthrottled (each is its own death) and under its own version. */
export function reportUncleanExits(exits: UncleanExit[] = collectUncleanExits()): number {
  for (const exit of exits) {
    reportError(uncleanShutdownError(), exit.context, { code: 'unclean_shutdown', version: exit.marker.reportVersion, unthrottled: true });
  }
  return exits.length;
}

export class UncleanShutdown extends Error {
  override name = 'UncleanShutdown';
}

/** The previous cockpit's death as an error report. No stack: it would point here, not there. */
export function uncleanShutdownError(): UncleanShutdown {
  const err = new UncleanShutdown('The previous cezar process ended without shutting down');
  err.stack = undefined;
  return err;
}

export class SupervisorGone extends Error {
  override name = 'SupervisorGone';
}

/** The desktop shell vanished without stopping its cockpit first: a quit always does that. */
export function supervisorGoneError(): SupervisorGone {
  const err = new SupervisorGone('The desktop shell exited without stopping the cockpit');
  err.stack = undefined;
  return err;
}
