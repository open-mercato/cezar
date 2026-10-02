import { spawn, spawnSync } from 'node:child_process';

export const CHECK_OUTPUT_CAP = 20_000;
/** Mirrors the agent runners' own run timeout. */
export const DEFAULT_CHECK_TIMEOUT_MS = 30 * 60_000;

const HEAD_SHARE = 0.25;
const MARKER_RESERVE = 64;
const ORPHAN_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for the output pipe to close before settling without it. */
const HARD_SETTLE_MS = 500;

/**
 * Captured check output bounded to `cap` chars: the first quarter and the last three quarters
 * survive, cut on line boundaries, with one marker line for what was dropped between them. The
 * tail is the larger half because test runners and compilers print the verdict last.
 */
export class CheckOutputBuffer {
  private readonly headCap: number;
  private readonly tailCap: number;
  private head = '';
  private headFull = false;
  private tail = '';
  private omittedLines = 0;
  private omittedChars = 0;
  private droppedMidLine = false;

  constructor(cap = CHECK_OUTPUT_CAP) {
    this.headCap = Math.floor(cap * HEAD_SHARE);
    this.tailCap = Math.max(0, cap - this.headCap - MARKER_RESERVE);
  }

  append(chunk: string): void {
    if (!this.headFull) {
      const room = this.headCap - this.head.length;
      if (chunk.length <= room) {
        this.head += chunk;
        return;
      }
      const candidate = this.head + chunk;
      const lastNl = candidate.lastIndexOf('\n', this.headCap - 1);
      const cut = lastNl >= 0 ? lastNl + 1 : this.headCap;
      this.head = candidate.slice(0, cut);
      this.headFull = true;
      chunk = candidate.slice(cut);
    }
    this.tail += chunk;
    if (this.tail.length > this.tailCap * 2) this.trimTail();
  }

  text(): string {
    this.trimTail();
    if (this.omittedChars === 0) return this.head + this.tail;
    const head = this.head.endsWith('\n') ? this.head : `${this.head}\n`;
    return `${head}… ${this.omittedLines} lines omitted …\n${this.tail}`;
  }

  private trimTail(): void {
    if (this.tail.length <= this.tailCap) return;
    let start = this.tail.length - this.tailCap;
    const nl = this.tail.indexOf('\n', start - 1);
    if (nl >= 0 && nl < this.tail.length - 1) start = nl + 1;
    const dropped = this.tail.slice(0, start);
    this.omittedChars += dropped.length;
    this.omittedLines += countLines(dropped) - (this.droppedMidLine ? 1 : 0);
    this.droppedMidLine = !dropped.endsWith('\n');
    this.tail = this.tail.slice(start);
  }
}

function countLines(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return s.endsWith('\n') || s.length === 0 ? n : n + 1;
}

// CSI (incl. SGR colours and cursor moves), OSC (hyperlinks, titles), two-byte escapes, and a
// sequence left unfinished where a killed process stopped writing.
const ANSI_RE =
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|\u001B(?:\[[0-?]*[ -/]*)?$/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');
}

export interface CheckResult {
  ok: boolean;
  exitCode: number;
  output: string;
  timedOut: boolean;
}

/**
 * Exit 127 is bash's "command not found". A check sees neither the host's full environment nor a
 * login profile, so a PATH entry only a shell profile adds (nvm, asdf, a GUI-launched cezar) is
 * the usual cause.
 */
export const COMMAND_NOT_FOUND_HINT =
  'exit code 127 means a command was not found: checks run without login profiles and with a scrubbed environment, so start cezar from a shell whose PATH has the tool, or forward a missing variable with CEZ_ENV_PASSTHROUGH';

/**
 * Any non-zero exit may be the scrubbed environment: a check that reads a variable the host has
 * (a test database URL, a registry token) fails with a tool's own error, which never names the
 * dropped variable. The hint is attached to every failure so the cause is visible then, not only
 * on the rare exit 127.
 */
export const ENV_PASSTHROUGH_HINT =
  'checks run with a scrubbed environment (no login profile, no backend credentials): if this failed because a variable was missing, forward it with CEZ_ENV_PASSTHROUGH=NAME (or restore everything with CEZ_AGENT_ENV_FULL=1)';

export function checkExitHint(result: CheckResult): string | undefined {
  if (result.timedOut || result.exitCode === 0) return undefined;
  return result.exitCode === 127 ? COMMAND_NOT_FOUND_HINT : ENV_PASSTHROUGH_HINT;
}

export function formatCheckFailure(command: string, result: CheckResult, timeoutMs: number): string {
  const status = result.timedOut
    ? `timed out after ${formatDuration(timeoutMs)} and was killed`
    : `exit code ${result.exitCode}`;
  const hint = checkExitHint(result);
  return `$ ${command}\n(${status})\n${hint ? `${hint}\n` : ''}\n${stripAnsi(result.output)}`;
}

export function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}

const liveGroups = new Set<number>();
let exitHookInstalled = false;

/**
 * SIGKILLs the process of every check still running. A check lives in its own group, so the
 * terminal's Ctrl-C or hangup no longer reaches it; cezar's shutdown and process exit call this
 * instead. On POSIX the whole group is signalled; on Windows the tree goes through
 * `taskkill /T /F`. Synchronous, so it is safe inside an `exit` handler.
 */
export function killLiveChecks(): void {
  const onWindows = process.platform === 'win32';
  for (const pid of liveGroups) {
    try {
      if (onWindows) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-pid, 'SIGKILL');
    } catch {
      // group already gone
    }
  }
  liveGroups.clear();
}

export interface CheckProcess {
  result: Promise<CheckResult>;
  kill: () => void;
}

/**
 * Runs `command` under `bash -c` in its own process group, so a timeout or a cancel reaches every
 * process the command started, not only bash: a backgrounded server or a watcher left by the
 * check would otherwise outlive the step.
 */
export function runCheckCommand(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): CheckProcess {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const posix = process.platform !== 'win32';
  const child = spawn('bash', ['-c', opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    detached: posix,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (pid !== undefined) {
    liveGroups.add(pid);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once('exit', killLiveChecks);
    }
  }
  const output = new CheckOutputBuffer();
  let timedOut = false;
  let settled = false;
  let exitCode: number | null = null;
  let timer: NodeJS.Timeout | undefined;
  let orphanTimer: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let hardSettle: NodeJS.Timeout | undefined;
  let resolveResult: (result: CheckResult) => void = () => undefined;
  const result = new Promise<CheckResult>((resolve) => {
    resolveResult = resolve;
  });

  const untrack = () => {
    if (pid !== undefined) liveGroups.delete(pid);
  };
  const clearTimers = () => {
    clearTimeout(timer);
    clearTimeout(orphanTimer);
    clearTimeout(escalation);
    clearTimeout(hardSettle);
  };
  // `close` never fires while an escaped descendant holds the pipes, so settling there has to
  // release them itself: an undestroyed stdio pipe keeps cezar's event loop alive (headless
  // `cezar run` then hangs after its final status) and keeps feeding a completed check's output.
  const releasePipes = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    untrack();
    clearTimers();
    releasePipes();
    const text = output.text().trim() || '(no output)';
    resolveResult({ ok: exitCode === 0 && !timedOut, exitCode: exitCode ?? -1, output: text, timedOut });
  };

  const signalGroup = (signal: NodeJS.Signals) => {
    if (settled || pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const killTree = () => {
    if (settled || pid === undefined) return;
    if (posix) {
      signalGroup('SIGTERM');
      escalation ??= setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      escalation.unref?.();
    } else {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {
        child.kill('SIGKILL');
      });
    }
    // A process that left the group for its own session (`setsid`) answers no signal and keeps the
    // output pipe open, so `close` may never fire; settle anyway once the kill grace has passed.
    hardSettle ??= setTimeout(finish, KILL_GRACE_MS + HARD_SETTLE_MS);
    hardSettle.unref?.();
  };

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => output.append(chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => output.append(chunk));
  child.on('exit', (code) => {
    exitCode = code;
    // The group stays tracked until `finish`: bash exiting does not end the group, and a process
    // it backgrounded that still holds the pipe has to remain reachable by killLiveChecks.
    orphanTimer = setTimeout(killTree, ORPHAN_GRACE_MS);
    orphanTimer.unref?.();
  });
  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    untrack();
    clearTimers();
    releasePipes();
    resolveResult({ ok: false, exitCode: -1, output: `failed to spawn: ${err.message}`, timedOut: false });
  });
  child.on('close', (code) => {
    exitCode = code;
    finish();
  });

  timer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, timeoutMs);
  timer.unref?.();

  return { result, kill: killTree };
}
