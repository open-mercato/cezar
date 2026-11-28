/**
 * Process-level error logging for the long-running `serve` process. stderr is what the desktop
 * shell keeps in `~/.cezar/logs/cockpit.log`, so every line carries a timestamp.
 *
 * An unhandled rejection is logged with its stack, reported to telemetry (consent permitting) and
 * the cockpit keeps serving: one failed promise chain (a request, a task's side job) leaves the
 * rest of the process consistent, and Node's default (exit 1) took every running task down with
 * it. Without this report it would vanish from crash telemetry, which only heard of it through
 * that default's `uncaughtException`. An uncaught exception only gets a timestamped header here:
 * the process state is unknown after a throw nobody caught, so Node (or the telemetry crash
 * reporter) still prints the stack, reports it and ends the process.
 */

export interface CrashLoggingOptions {
  write?: (line: string) => void;
  now?: () => Date;
  /** `serve` passes telemetry's `reportError`, kept out of this module's imports. */
  report?: (reason: unknown) => void;
}

/** The error's stack when it has one, else its string form — a rejection may carry any value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  try {
    return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Installs the two handlers; returns their removal (tests, and a process that hands off). */
export function installCrashLogging(opts: CrashLoggingOptions = {}): () => void {
  const write = opts.write ?? ((line: string) => {
    try {
      process.stderr.write(line);
    } catch {
      // A closed stderr must not turn a logged error into a crash.
    }
  });
  const now = opts.now ?? (() => new Date());
  const report = opts.report ?? (() => {});
  const onRejection = (reason: unknown): void => {
    write(`[cez] ${now().toISOString()} unhandled promise rejection — the cockpit keeps running:\n${describeError(reason)}\n`);
    try {
      report(reason);
    } catch {
      // Reporting must never turn a survived rejection into a crash.
    }
  };
  const onException = (_error: Error, origin: string): void => {
    write(`[cez] ${now().toISOString()} uncaught exception (${origin}) — the cockpit stops; the stack follows:\n`);
  };
  process.on('unhandledRejection', onRejection);
  // The monitor observes without handling: Node's own crash path (or telemetry's) still runs.
  process.on('uncaughtExceptionMonitor', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtExceptionMonitor', onException);
  };
}
