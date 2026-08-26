import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { RemoteControlState } from '@open-mercato/cezar-contract';
import { refuseSpawnUnderTest } from './open-in-terminal.ts';

/**
 * Claude Remote Control, cockpit-managed (spec 2026-08-26-remote-control): one persistent
 * `claude remote-control` child per project, so sessions in the repo can be driven from
 * claude.ai/code or the Claude mobile app — the cockpit's answer to typing
 * `/remote-control` in an interactive session.
 *
 * Why a project-level server and not a per-task attach: the `--remote-control` flag is
 * silently ignored in the headless stream-json mode every cezar task runs in, and
 * `claude remote-control --session-id` reattaches only sessions Remote Control itself
 * recorded — see the spec's CLI-probe notes. The subcommand, in contrast, needs no TTY:
 * it asks `Enable Remote Control? (y/n)` on stdin (answered with `y\n` here), prints the
 * `https://claude.ai/code?environment=env_…` link, and runs until killed.
 *
 * The service never *decides* to connect anything: `start()` runs only on an explicit
 * cockpit click, which is the opt-in (no `CEZ_*` flag — nothing automatic to gate).
 */

/** What the routes compose the wire `RemoteControlStatus` from — everything except the
 *  deployment-level `available`/`reason`, which are `capabilities()`'s to answer. */
export interface RemoteControlProcessStatus {
  state: RemoteControlState;
  url?: string;
  startedAt?: string;
  error?: string;
}

export interface RemoteControlStartOptions {
  /** The project's current claude account env (`handoffEnv`) — same resolution as the
   *  terminal handoff, so Remote Control talks to the account the project uses. */
  extraEnv?: Record<string, string>;
  /** Isolate phone-spawned sessions in worktrees (git repos only — the house doctrine
   *  that agents never run in the protected checkout, see `POST /open-in`). */
  worktrees?: boolean;
}

export interface RemoteControlServiceDeps {
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  /** How long the CLI gets to print the claude.ai link before start() gives up. */
  connectTimeoutMs?: number;
  /** How long SIGINT gets before stop() escalates to SIGKILL. */
  killGraceMs?: number;
}

const CONNECT_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 3_000;
/** Output kept per process for error extraction — the CLI redraws its status block in a
 *  loop, so unbounded capture would grow forever on a long-lived server. */
const OUTPUT_CAP = 64_000;

const ENVIRONMENT_URL = /https:\/\/claude\.ai\/code\?environment=env_[A-Za-z0-9_-]+/;

interface RcEntry {
  child: ChildProcess | null;
  state: RemoteControlState;
  url?: string;
  startedAt?: string;
  error?: string;
  /** stop() in flight — an exit observed now is deliberate, not a crash. */
  stopping: boolean;
  output: string;
  /** In-flight start(), shared by concurrent callers. */
  starting?: Promise<RemoteControlProcessStatus>;
  /** Removes this child's process-exit kill hook once the child is gone. */
  unhook?: () => void;
}

export class RemoteControlService {
  private readonly entries = new Map<string, RcEntry>();

  constructor(private readonly deps: RemoteControlServiceDeps = {}) {}

  status(root: string): RemoteControlProcessStatus {
    const entry = this.entries.get(root);
    if (!entry) return { state: 'stopped' };
    return snapshot(entry);
  }

  /** Idempotent: `running`/`starting` answer with the existing process. Resolves with the
   *  final state — `running` (link parsed), or `error` (refusal, crash, or timeout) — so
   *  the caller never has to poll. */
  start(root: string, opts: RemoteControlStartOptions = {}): Promise<RemoteControlProcessStatus> {
    const existing = this.entries.get(root);
    if (existing?.starting) return existing.starting;
    if (existing?.state === 'running') return Promise.resolve(snapshot(existing));

    const env = this.deps.env ?? process.env;
    if (env.CEZ_DRY_RUN === '1') {
      // Same doctrine as the faked draft-PR URL: the cockpit must be exercisable offline.
      const entry: RcEntry = {
        child: null,
        state: 'running',
        url: 'https://claude.ai/code?environment=env_dry-run',
        startedAt: new Date().toISOString(),
        stopping: false,
        output: '',
      };
      this.entries.set(root, entry);
      return Promise.resolve(snapshot(entry));
    }

    const entry: RcEntry = { child: null, state: 'starting', stopping: false, output: '' };
    this.entries.set(root, entry);
    entry.starting = this.launch(root, entry, opts).finally(() => {
      entry.starting = undefined;
    });
    return entry.starting;
  }

  /** SIGINT, then SIGKILL after the grace window; resolves once the child is gone. A
   *  stop with nothing running still answers `stopped` (and clears a sticky `error`). */
  async stop(root: string): Promise<RemoteControlProcessStatus> {
    const entry = this.entries.get(root);
    if (!entry) return { state: 'stopped' };
    entry.stopping = true;
    const child = entry.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await terminate(child, this.deps.killGraceMs ?? KILL_GRACE_MS);
    }
    entry.unhook?.();
    this.entries.delete(root);
    return { state: 'stopped' };
  }

  /** Project removal / server teardown: kill without waiting. */
  dispose(root: string): void {
    const entry = this.entries.get(root);
    if (!entry) return;
    entry.stopping = true;
    try {
      entry.child?.kill('SIGTERM');
    } catch {
      // already gone
    }
    entry.unhook?.();
    this.entries.delete(root);
  }

  disposeAll(): void {
    for (const root of [...this.entries.keys()]) this.dispose(root);
  }

  private async launch(
    root: string,
    entry: RcEntry,
    opts: RemoteControlStartOptions,
  ): Promise<RemoteControlProcessStatus> {
    const env = this.deps.env ?? process.env;
    const bin = env.CEZ_CLAUDE_BIN ?? 'claude';
    const args = ['remote-control'];
    if (opts.worktrees) args.push('--spawn', 'worktree', '--no-create-session-in-dir');

    // #824: a real `claude remote-control` from a test would register this machine with
    // claude.ai — a test must inject `deps.spawn` (an injected fake needs no exemption).
    if (!this.deps.spawn) refuseSpawnUnderTest(bin, args);
    const spawn = this.deps.spawn ?? nodeSpawn;

    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: root,
        env: { ...env, ...opts.extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return this.fail(entry, `could not start ${bin}: ${(err as Error).message}`);
    }
    entry.child = child;

    // cezar exiting must not leave an orphaned Remote Control behind: the cockpit is the
    // only thing that knows it exists. Sync kill on 'exit'; unhooked when the child dies.
    const onProcessExit = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    };
    process.once('exit', onProcessExit);
    entry.unhook = () => process.removeListener('exit', onProcessExit);

    // The subcommand confirms on stdin; EOF would be its cue to exit, so the pipe stays
    // open for the child's lifetime. EPIPE from a child that quit first is expected.
    child.stdin?.on('error', () => {});
    child.stdin?.write('y\n');

    // Resolves on whichever comes first: the link (running), the child exiting, or the
    // connect timeout — the three listeners below all funnel into this one resolver.
    let settle: (outcome: 'settled' | 'timeout') => void = () => {};
    const settled = new Promise<'settled' | 'timeout'>((resolve) => {
      settle = resolve;
    });

    const onOutput = (chunk: Buffer) => {
      entry.output = (entry.output + chunk.toString('utf8')).slice(-OUTPUT_CAP);
      const url = entry.output.match(ENVIRONMENT_URL)?.[0];
      if (url && entry.state === 'starting') {
        entry.state = 'running';
        entry.url = url;
        entry.startedAt = new Date().toISOString();
        settle('settled');
      }
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);

    child.once('exit', (code) => {
      entry.unhook?.();
      entry.child = null;
      if (!entry.stopping && (entry.state === 'starting' || entry.state === 'running')) {
        entry.state = 'error';
        entry.error = exitReason(entry.output, code);
      }
      settle('settled');
    });

    const timeoutTimer = setTimeout(
      () => settle('timeout'),
      this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    timeoutTimer.unref?.();
    const outcome = await settled;
    clearTimeout(timeoutTimer);
    if (entry.state === 'running') return snapshot(entry);
    if (outcome === 'timeout' && entry.state === 'starting') {
      entry.stopping = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      entry.unhook?.();
      entry.child = null;
      entry.state = 'error';
      entry.error = 'timed out waiting for Remote Control to connect to claude.ai';
    }
    return snapshot(entry);
  }

  private fail(entry: RcEntry, message: string): RemoteControlProcessStatus {
    entry.state = 'error';
    entry.error = message;
    entry.child = null;
    return snapshot(entry);
  }
}

/** Conditional spreads — the wire shape drops absent keys, never carries `undefined`. */
function snapshot(entry: RcEntry): RemoteControlProcessStatus {
  return {
    state: entry.state,
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  };
}

function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once('exit', settle);
    try {
      child.kill('SIGINT');
    } catch {
      settle();
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      // SIGKILL cannot be ignored; if 'exit' still never fires the process is beyond
      // this API anyway — resolve rather than hang the route.
      setTimeout(settle, 500).unref?.();
    }, graceMs);
    killTimer.unref?.();
  });
}

/** The human reason behind an early exit: the CLI's own `Error: …` line when it printed
 *  one (workspace trust refusal included), else the last non-empty line, else the code. */
export function exitReason(output: string, code: number | null): string {
  const lines = stripAnsi(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const explicit = lines.find((line) => line.startsWith('Error:'));
  const last = explicit ?? lines.at(-1);
  const suffix = `exited${code !== null ? ` with code ${code}` : ''}`;
  return last ? `${last.slice(0, 300)} (${suffix})` : `claude remote-control ${suffix}`;
}

/** CSI sequences and OSC-8 hyperlink wrappers — what the CLI's status redraws are made
 *  of. Enough for error lines; the URL regex matches through untouched text anyway. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
}
