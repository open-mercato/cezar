/**
 * How a cockpit comes back after an update. Two modes:
 *
 *   reexec      the default from a terminal: close the listener, spawn the ACTIVE entry (which,
 *               after `activate`, is the new version) detached with the same argv, and exit. The
 *               child inherits the terminal so its banner lands where the old one did; the port is
 *               pinned so the browser's origin keeps working.
 *   supervisor  `CEZ_SUPERVISED=1` (the desktop shell, a systemd/launchd unit): just exit with
 *               `RESTART_EXIT_CODE` — the supervisor relaunches through the launcher, which
 *               resolves `current` afresh. Re-exec'ing under a supervisor would orphan the child
 *               from the process the supervisor watches.
 *
 * Running agents are child processes of this one and die with it; boot recovery (#367) re-queues
 * or resumes their runs on the next start. The dialog warns before that happens.
 */

import { spawn } from 'node:child_process';

import { currentEntry } from './layout.ts';

/** The slice of `http.Server` a restart needs — `@hono/node-server`'s `ServerType` is a union
 *  over http/https/http2 servers, and every member has these two. */
export interface ClosableServer {
  close(callback?: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
}

/** Exit status meaning "relaunch me" to a supervisor. 75 is EX_TEMPFAIL — retry later. */
export const RESTART_EXIT_CODE = 75;

export interface RestartOptions {
  server: ClosableServer | null;
  /** Original CLI args (`process.argv.slice(2)`); the port is pinned over them. */
  args: string[];
  port: number;
  supervised: boolean;
  /** The entry to spawn; defaults to the managed `current` entry. */
  entry?: string;
  env?: NodeJS.ProcessEnv;
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_SUPERVISED === '1' || env.CEZ_DESKTOP === '1';
}

/** Build the child argv: the same command and flags, the port pinned, no second browser tab. */
export function restartArgs(args: string[], port: number): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-p' || arg === '--port') {
      i++;
      continue;
    }
    if (arg.startsWith('--port=') || arg.startsWith('-p=')) continue;
    if (arg === '--no-open') continue;
    kept.push(arg);
  }
  return [...kept, '--port', String(port), '--no-open'];
}

export function restartProcess(opts: RestartOptions): void {
  let started = false;
  const done = () => {
    if (started) return;
    started = true;
    if (opts.supervised) {
      process.exit(RESTART_EXIT_CODE);
    }
    const entry = opts.entry ?? currentEntry(opts.env);
    const child = spawn(process.execPath, [...process.execArgv, entry, ...restartArgs(opts.args, opts.port)], {
      detached: true,
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...(opts.env ?? process.env), CEZ_RESTARTED_FROM: process.pid.toString() },
    });
    child.on('error', (error) => {
      console.error(`cezar: restart failed — ${error.message}`);
      process.exit(1);
    });
    child.unref();
    // Give the spawn a beat to fail loudly before we go; the child binds the port only after the
    // listener below is gone, which `close()` guarantees before `done` ran.
    setTimeout(() => process.exit(0), 300);
  };
  if (!opts.server) return done();
  // SSE and WebSocket clients hold the listener open indefinitely — drop them first.
  opts.server.closeAllConnections?.();
  opts.server.close(() => done());
  // A listener that refuses to close (a stuck upgrade) must not pin the old version forever.
  setTimeout(done, 3_000).unref();
}
