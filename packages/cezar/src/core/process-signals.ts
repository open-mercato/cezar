/**
 * Which terminating signals THIS process received. An agent child shares cezar's process group,
 * systemd cgroup (`KillMode=control-group`) and login session, so a terminal's Ctrl-C, a unit stop
 * or a macOS logout signals both at once — and the child's own handler exits `128 + n` while cezar
 * is still shutting down. That exit is cezar's shutdown, not an agent crash (telemetry 3ac6bbe3).
 */

const WATCHED = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
export type OwnSignal = keyof typeof WATCHED;

/** Lets the event loop run the signal listener when the child's exit was observed first. */
const SIGNAL_RACE_MS = 250;
/** How long a session whose child died with cezar's own signal waits for the process to exit. */
const DEFAULT_SHUTDOWN_HOLD_MS = 60_000;
let shutdownHoldMs = DEFAULT_SHUTDOWN_HOLD_MS;

const received = new Map<OwnSignal, number>();
let watching = false;

/** Start recording; idempotent. Passive: alone on a signal, the listener re-raises it so Node's
 *  default exit still happens (any listener would otherwise swallow it). */
export function watchOwnSignals(): void {
  if (watching) return;
  watching = true;
  for (const signal of Object.keys(WATCHED) as OwnSignal[]) {
    const listener = (): void => {
      recordOwnSignal(signal);
      if (process.listenerCount(signal) !== 1) return;
      process.removeListener(signal, listener);
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(128 + WATCHED[signal]);
      }
    };
    try {
      process.prependListener(signal, listener);
    } catch {
      // a platform without this signal
    }
  }
}

/** Exported for tests: what a real delivery records. */
export function recordOwnSignal(signal: OwnSignal, at = Date.now()): void {
  received.set(signal, at);
}

/** Test-only: forget every recorded signal and set the shutdown hold. */
export function resetOwnSignalsForTests(holdMs = DEFAULT_SHUTDOWN_HOLD_MS): void {
  received.clear();
  shutdownHoldMs = holdMs;
}

/** True when cezar received any watched signal at or after `sinceMs`. */
export function receivedOwnSignalSince(sinceMs: number): boolean {
  for (const at of received.values()) if (at >= sinceMs) return true;
  return false;
}

function ownSignalNamedBy(exitCode: number, sinceMs: number): OwnSignal | undefined {
  const signal = (Object.keys(WATCHED) as OwnSignal[]).find((s) => WATCHED[s] === exitCode - 128);
  const at = signal && received.get(signal);
  return at !== undefined && at >= sinceMs ? signal : undefined;
}

/** The signal cezar itself received since `sinceMs` that a child's `128 + n` exit names. */
export async function ownSignalBehindExit(exitCode: number | null, sinceMs: number): Promise<OwnSignal | undefined> {
  if (exitCode === null) return undefined;
  const code = exitCode;
  if (!(Object.values(WATCHED) as number[]).includes(code - 128)) return undefined;
  const now = ownSignalNamedBy(code, sinceMs);
  if (now) return now;
  await new Promise((resolve) => setTimeout(resolve, SIGNAL_RACE_MS));
  return ownSignalNamedBy(code, sinceMs);
}

/** Leave the session unsettled while cezar exits, so the run stays `running` on disk and boot
 *  recovery resumes it (#367); unref'd, so it never keeps a stopping process alive. */
export function holdForOwnShutdown(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, shutdownHoldMs).unref?.());
}

/** The `interrupted — ` prefix is restart bookkeeping: telemetry and `task_failed` skip it. */
export function ownShutdownExitMessage(label: string, signal: OwnSignal, exitCode: number): string {
  return `interrupted — cezar received ${signal} and the ${label} stopped with it (code ${exitCode})`;
}
