/**
 * Best-effort record of HOW the server process ended (#2262). A hidden launch leaves stderr empty,
 * so each abnormal end appends one line to `<cezarHome>/logs/server-exit.log`: time, pid, reason,
 * signal/code, uptime, memory, error stack. Never throws and never changes how the process exits —
 * only `uncaughtExceptionMonitor` and `exit` observers, plus signal listeners that re-raise.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cezarHomeDir } from './paths.ts';

export const EXIT_LOG_MAX_BYTES = 256 * 1024;
const SIGNALS = ['SIGHUP', 'SIGBREAK', 'SIGINT', 'SIGTERM'] as const;

export function exitLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'logs', 'server-exit.log');
}

export function formatExitLine(reason: string, detail: Record<string, unknown> = {}, now = new Date()): string {
  const mem = process.memoryUsage();
  const record = {
    at: now.toISOString(),
    pid: process.pid,
    reason,
    ...detail,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    node: process.version,
    platform: process.platform,
  };
  return `${JSON.stringify(record)}\n`;
}

/** Synchronous append with a size cap (one rotation to `.1`); swallows every failure. */
export function appendExitRecord(path: string, line: string, maxBytes = EXIT_LOG_MAX_BYTES): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    try {
      if (statSync(path).size + line.length > maxBytes) renameSync(path, `${path}.1`);
    } catch {
      // no file yet
    }
    appendFileSync(path, line, 'utf8');
  } catch {
    // diagnostics must never take the server down
  }
}

let installed = false;

/** Install once per process; returns whether it did. */
export function installExitDiagnostics(env: NodeJS.ProcessEnv = process.env): boolean {
  if (installed)
  installed = true;
  const path = exitLogPath(env);
  const write = (reason: string, detail?: Record<string, unknown>): void =>
    appendExitRecord(path, formatExitLine(reason, detail));
  let abnormal = false;

  // Observer only: Node's default handling (and telemetry's listener) still run.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    abnormal = true;
    write(origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException', {
      origin,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  });

  for (const signal of SIGNALS) {
    const listener = (): void => {
      abnormal = true;
      write('signal', { signal });
      // Alone on a signal that kills by default (SIGHUP/SIGBREAK), re-raise so it still does.
      if (process.listenerCount(signal) !== 1) return;
      process.removeListener(signal, listener);
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(128);
      }
    };
    try {
      process.prependListener(signal, listener);
    } catch {
      // a platform without this signal
    }
  }

  process.on('exit', (code) => {
    if (code !== 0 || abnormal) write('exit', { code });
  });
  return true;
}

/** Test-only. */
export function resetExitDiagnosticsForTests(): void {
  installed = false;
}
