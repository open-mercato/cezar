/**
 * Unclean-shutdown detection (docs/telemetry.md § "Unclean shutdowns"). A SIGKILL, an OOM kill or
 * a crash in native code ends the process before any handler runs, so the process that died can
 * never say so: on 2026-11-25 the desktop app was SIGKILLed twice and nothing was reported.
 *
 * Each `serve` keeps a marker, `~/.cezar/telemetry/live/<pid>.json`, refreshed every minute and
 * removed on every exit Node gets to see (`process.on('exit')`: a graceful stop, a restart,
 * `process.exit`, an uncaught exception). The next `serve` finds a marker whose process is gone and
 * reports it — consent permitting — with what the marker and the desktop shell's
 * `~/.cezar/logs/cockpit.log` (#2489, when present) say about it: facts only, never output text.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime as hostUptime } from 'node:os';
import { join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from './paths.ts';
import type { ContextValue } from './telemetry.ts';

const BEAT_MS = 60_000;
/** A marker this old is a pid reused by something else, not a cezar: dropped unreported. */
const STALE_MS = 30 * 86_400_000;
/** How much of the cockpit log's end is read for the dead process's lifecycle lines. */
const LOG_TAIL_BYTES = 64 * 1024;
/** The shell's own start line (#2489): `<ts> --- starting the cockpit: <entry> (port <n>)`. */
const STARTING_LINE = /^\S+ --- starting the cockpit: .* \(port \d+\)$/;

export interface LiveMarker {
  pid: number;
  startedAt: number;
  beatAt: number;
  version: string;
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

function writeMarker(dir: string, marker: LiveMarker): void {
  const file = join(dir, `${marker.pid}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Keep this process's marker until it exits. Never throws: a read-only home only loses detection. */
export function startLiveMarker(opts: {
  version: string;
  runtime: string;
  runsRunning?: () => number;
  dir?: string;
  beatMs?: number;
}): () => void {
  const dir = opts.dir ?? liveMarkerDir();
  const file = join(dir, `${process.pid}.json`);
  const startedAt = Date.now();
  const beat = () => {
    try {
      let runsRunning: number | undefined;
      try { runsRunning = opts.runsRunning?.(); } catch { /* the count is optional */ }
      writeMarker(dir, {
        pid: process.pid,
        startedAt,
        beatAt: Date.now(),
        version: opts.version,
        runtime: opts.runtime,
        rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        ...(runsRunning === undefined ? {} : { runsRunning }),
      });
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

function parseMarker(raw: string): LiveMarker | undefined {
  try {
    const m = JSON.parse(raw) as Partial<LiveMarker>;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!num(m.pid) || !num(m.startedAt) || !num(m.beatAt) || !num(m.rssMb)) return undefined;
    if (typeof m.version !== 'string' || typeof m.runtime !== 'string') return undefined;
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

/** What the desktop shell's cockpit log (#2489) knows about `pid`: its own `---` lifecycle lines
 *  (written by the shell, never the cockpit's output), when the process last printed anything, and
 *  whether the shell saw it end. Output text never leaves this function. */
export function logFacts(tail: string, pid: number): {
  lifecycle?: string;
  lastOutputAt?: string;
  endedBy?: string;
  signal?: number;
} {
  const lines = tail.split('\n').filter((line) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(line));
  const pidLine = ` --- cockpit process pid ${pid}`;
  let start = -1;
  lines.forEach((line, i) => { if (line.endsWith(pidLine)) start = i; });
  if (start < 0) return {};
  let end = lines.findIndex((line, i) => i > start && STARTING_LINE.test(line));
  if (end < 0) end = lines.length;
  const segment = lines.slice(start, end);
  // Output lines share the shell's format, so only the shell's exact lifecycle shapes are kept.
  const lifecycle = [
    ...(start > 0 && STARTING_LINE.test(lines[start - 1]!) ? [lines[start - 1]!] : []),
    ...segment.filter((line) => line.endsWith(pidLine) || line.includes(`${pidLine} ended: `)),
  ].slice(-6).join('\n');
  const lastOutputAt = segment.slice(1).filter((line) => !line.includes(`${pidLine} ended: `)).at(-1)?.split(' ')[0];
  const ended = segment.find((line) => line.includes(`${pidLine} ended: `));
  const endedBy = ended?.slice(ended.indexOf(' ended: ') + 8).trim();
  const signal = endedBy ? /signal: (\d+)/.exec(endedBy)?.[1] : undefined;
  return {
    ...(lifecycle ? { lifecycle } : {}),
    ...(lastOutputAt ? { lastOutputAt } : {}),
    ...(endedBy ? { endedBy } : {}),
    ...(signal ? { signal: Number(signal) } : {}),
  };
}

/**
 * Claim every marker whose process is gone and return those worth reporting. A claim is a rename,
 * so two cockpits booting together report a death once. Not reported: a host that restarted since
 * the last beat (power loss, a reboot — not cezar's failure) and a death the desktop shell already
 * saw and reported itself (`sidecar_killed`/`sidecar_exited`, its "ended" log line).
 */
export function collectUncleanExits(opts: {
  dir?: string;
  logTail?: string;
  now?: number;
  hostUptimeS?: number;
  isAlive?: (pid: number) => boolean;
} = {}): UncleanExit[] {
  const dir = opts.dir ?? liveMarkerDir();
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? pidAlive;
  const bootedAt = now - (opts.hostUptimeS ?? hostUptime()) * 1000;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  let tail: string | undefined = opts.logTail;
  const out: UncleanExit[] = [];
  for (const name of names) {
    const file = join(dir, name);
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    const marker = parseMarker(raw);
    if (marker && marker.pid === process.pid) continue;
    if (marker && isAlive(marker.pid) && now - marker.beatAt < STALE_MS) continue;
    const claimed = `${file}.claimed-${process.pid}`;
    try { renameSync(file, claimed); } catch { continue; } // another cockpit claimed it
    try { rmSync(claimed, { force: true }); } catch { /* best effort */ }
    if (!marker || isAlive(marker.pid)) continue; // malformed, or stale under a reused pid
    if (marker.beatAt < bootedAt) continue;
    tail ??= readTail(cockpitLogPath(), LOG_TAIL_BYTES);
    const log = logFacts(tail, marker.pid);
    if (log.endedBy) continue;
    out.push({
      marker,
      context: {
        'unclean.previous_version': marker.version,
        'unclean.previous_runtime': marker.runtime,
        'unclean.uptime_s': Math.round((marker.beatAt - marker.startedAt) / 1000),
        'unclean.last_beat_age_s': Math.round((now - marker.beatAt) / 1000),
        'unclean.rss_mb': marker.rssMb,
        ...(marker.runsRunning === undefined ? {} : { 'unclean.runs_running': marker.runsRunning }),
        ...(log.lastOutputAt ? { 'unclean.last_output_at': log.lastOutputAt } : {}),
        ...(log.lifecycle ? { 'unclean.log_lifecycle': log.lifecycle } : {}),
        'unclean.cockpit_log': tail.length > 0,
      },
    });
  }
  return out;
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
