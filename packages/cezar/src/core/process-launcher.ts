import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { disclaimedCommand } from './disclaim-spawn.ts';

/**
 * WHERE an agent process runs, as a seam separate from WHICH agent runs.
 *
 * Every runner (`claude`, `codex`, `opencode`, `pi`) spawns its CLI the same
 * way — `spawn(bin, args, { cwd, env })` — so isolation is not a property of
 * the backend and must not become a fifth `RunnerId`. It is a property of the
 * launcher: `local` runs the CLI on this machine, `podman` runs the identical
 * argv inside the task's container.
 *
 * The seam carries `signal()` as well as `spawn()` because the two diverge:
 * locally, killing the child kills the agent; through `podman exec`, killing the
 * client leaves the agent running inside the container (measured, not assumed).
 * Every runner arms a SIGTERM→SIGKILL watchdog on teardown and signals on
 * `interrupt()`, so a launcher that cannot reach its own process would silently
 * lose both.
 */
export interface LaunchOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProcessLauncher {
  /** Stable id for logs, run records and config. */
  readonly id: 'local' | 'podman';
  /** One line naming where this launcher puts the agent — shown in run notes. */
  describe(): string;
  /**
   * The agent homes an isolated agent uses, on the host (per project — `agentHomesFor`).
   * Undefined on this machine's launcher, where an agent uses its own home. A runner that reads
   * its agent's files from the host (Kimi's usage log) looks there.
   */
  readonly agentHomes?: { claude: string; kimi: string };
  /**
   * A host port forwarded into the container, for a backend that talks HTTP to
   * its own agent process (opencode `serve`) rather than over stdio.
   *
   * `undefined` on the local launcher, where there is nothing to forward. A
   * backend that needs one and does not get one must NOT silently bind a random
   * port: inside a container that port is unreachable from the host, and the
   * failure looks like a hung agent rather than a networking mistake.
   */
  readonly publishedPort?: number;
  spawn(bin: string, args: string[], opts: LaunchOpts): ChildProcessWithoutNullStreams;
  /**
   * Deliver `sig` to the agent process. Resolves once the signal has been
   * *sent*, never waiting for the process to die — callers layer their own
   * escalation timers on top.
   */
  signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): Promise<void>;
}

/** The launcher cezar has always used: spawn on this machine. */
export class LocalLauncher implements ProcessLauncher {
  readonly id = 'local' as const;

  describe(): string {
    return 'this machine';
  }

  spawn(bin: string, args: string[], opts: LaunchOpts): ChildProcessWithoutNullStreams {
    // On this machine the agent is started as its own responsible process, so a
    // macOS privacy prompt names the agent rather than the app (`disclaim-spawn.ts`).
    // A container launcher never does: the agent there is not a macOS process.
    const [file, argv] = disclaimedCommand(bin, args, opts.env);
    return nodeSpawn(file, argv, { cwd: opts.cwd, env: opts.env }) as ChildProcessWithoutNullStreams;
  }

  async signal(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals): Promise<void> {
    // `kill` throws only for an already-reaped pid, which is the outcome we want.
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

/** The default launcher, so existing call sites keep their exact behaviour. */
export const localLauncher = new LocalLauncher();
