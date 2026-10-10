import { randomUUID } from 'node:crypto';

import { SCAN_OVERLAP, type DetectedUrls } from './detected-urls.ts';
import { foregroundCommand, hasForeground, type ProcessRow } from './foreground.ts';
import { loadPty, type PtyProcess } from './pty-module.ts';
import { resolveShell } from './shells.ts';

/**
 * Interactive terminal sessions, one PTY each, scoped to a task worktree (spec
 * `.ai/specs/2026-10-07-task-workspace.md` §6, Milestone 2).
 *
 * This is a NEW host-process capability, not an extension of an existing one: before it, nothing
 * in cezar owned a long-lived child beyond a single agent run, and nothing anywhere killed a
 * process TREE — the agent runners signal their direct child only, and grandchildren (an agent's
 * own Bash calls) are observed for telemetry but never reaped. A shell is the opposite case: what
 * the user starts in it (`npm run dev`, `make dev`) is precisely the grandchildren, so "stop" has
 * to mean the whole tree or it means nothing.
 *
 * The mechanism is the process GROUP. A PTY is allocated through `forkpty`, which calls `setsid`,
 * so the shell is a session and group leader and every descendant inherits that group id; a
 * negative-pid signal reaches all of them at once. Verified on this platform before the code was
 * written: `process.kill(-pid, 0)` resolves, and a `SIGKILL` to the group reaps a sleeping child.
 * Windows has no process groups, so there the binding's own `kill()` is the whole story — it
 * terminates the job object node-pty created.
 */

/** Scrollback held per session, in characters. Enough to scroll back through a failed build; small
 *  enough that ten forgotten sessions cost megabytes, not hundreds. */
export const SCROLLBACK_LIMIT = 256_000;

/** Sessions alive at once, across every task. A bound, not a quota: the number exists so a runaway
 *  client cannot fork shells until the host dies. */
export const MAX_SESSIONS = 32;

/** How long a session that has EXITED is kept so its last output and exit code can still be read
 *  (a client that was mid-poll, or a drawer reopened a moment later). */
const EXITED_RETENTION_MS = 60_000;

export interface TerminalSessionInfo {
  id: string;
  runId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  startedAt: string;
  /** Null while the shell is alive. */
  exitCode: number | null;
  /**
   * What the tab is called: the running (or last-run) command, falling back to `Terminal N`
   * (spec §6). The command STICKS after it finishes — a tab that ran the build should still say
   * so while you read its output — and is replaced only when another command starts.
   */
  label: string;
  /**
   * The shell has a live child. Drives the close warning, and is why that warning can never
   * disagree with the tab name: both come from the same process-table reading.
   *
   * `null` means THIS HOST CANNOT SAY — no `ps` (Windows) or a hidden process table. It is not
   * `false`, because `false` is the positive claim "nothing is running", and on a host that
   * cannot tell, that claim silently turned off the close warning §6 requires. The client treats
   * anything but `false` as "ask first".
   */
  busy: boolean | null;
}

export interface TerminalRead {
  /** Output since the requested cursor. */
  data: string;
  /** Pass this back on the next read. */
  cursor: number;
  /** The requested cursor was older than the retained scrollback — output was missed. */
  truncated: boolean;
  exitCode: number | null;
}

interface Entry {
  info: TerminalSessionInfo;
  /** 1-based within its task — the `N` in the default `Terminal N`. Assigned once, so closing
   *  tab 2 of three does not renumber the others under the user's cursor. */
  ordinal: number;
  pty: PtyProcess;
  /** Retained output, newest-last, capped at `SCROLLBACK_LIMIT`. */
  buffer: string;
  /** Characters already dropped off the front — the cursor of `buffer[0]`. */
  dropped: number;
  listeners: Set<() => void>;
  disposers: Array<() => void>;
  /** The tail of the previous chunk, re-scanned with the next one so an address split across two
   *  PTY writes is still found whole. */
  scanTail: string;
  reap?: ReturnType<typeof setTimeout>;
}

export interface CreateSessionInput {
  runId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** One of the host's discovered shells (`discoverShells()`). Anything else is refused rather
   *  than spawned — see the allowlist reasoning in `shells.ts`. */
  shell?: string;
  /** Layered over the server's own environment — what this task's shell is told that another
   *  task's is not (its slot). Chosen by the server, never read from a request. */
  env?: Record<string, string>;
}

export type CreateSessionResult =
  | { ok: true; session: TerminalSessionInfo }
  | { ok: false; reason: string };

/**
 * Every live registry in this process.
 *
 * A module-level set is the right scope for exactly one job: the signal handler in `index.ts`
 * must kill every shell before the process exits, and it has no handle on the server, let alone
 * on a registry built deep inside `createApp`. It matters more here than anywhere else in cezar
 * because a PTY child is in its OWN process group — so, unlike the agent runners' children, it
 * does NOT receive the Ctrl-C the TTY delivers to cezar's foreground group, and it would outlive
 * the cockpit silently.
 */
const registries = new Set<TerminalSessions>();

/** Stop every terminal in this process, from a signal handler or a test's teardown. */
export function closeAllTerminals(): void {
  for (const registry of [...registries]) registry.closeAll();
}

export class TerminalSessions {
  private entries = new Map<string, Entry>();

  /** `binding` is injectable so tests drive a fake PTY and never fork a real shell. `urls`, when
   *  given, is fed every chunk of output so a task's printed addresses are collected as they
   *  appear (spec §7) — optional because the registry is useful without it. */
  constructor(
    private readonly binding: typeof loadPty = loadPty,
    private readonly urls?: DetectedUrls,
  ) {
    registries.add(this);
  }

  async create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const pty = await this.binding();
    if (!pty.available) return { ok: false, reason: pty.reason };
    if (this.entries.size >= MAX_SESSIONS) {
      return { ok: false, reason: `Too many terminal sessions (${MAX_SESSIONS}). Close one and retry.` };
    }

    const cols = clampDimension(input.cols, 80);
    const rows = clampDimension(input.rows, 24);
    // The host decides what is openable; a request may only pick from that list (`shells.ts`).
    const shell = resolveShell(input.shell);
    if (shell === null) {
      return { ok: false, reason: `This host does not offer the shell ${JSON.stringify(input.shell)}.` };
    }
    let child: PtyProcess;
    try {
      child = pty.module.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: input.cwd,
        env: { ...terminalEnv(), ...input.env },
      });
    } catch (error) {
      // A worktree that was reclaimed between the check and the spawn lands here, as does a shell
      // that is not executable. Both are answers, not crashes.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    const ordinal = this.nextOrdinal(input.runId);
    const entry: Entry = {
      info: {
        id: randomUUID(),
        runId: input.runId,
        cwd: input.cwd,
        shell,
        cols,
        rows,
        startedAt: new Date().toISOString(),
        exitCode: null,
        label: `Terminal ${ordinal}`,
        busy: false,
      },
      ordinal,
      pty: child,
      buffer: '',
      dropped: 0,
      listeners: new Set(),
      disposers: [],
      scanTail: '',
    };
    this.entries.set(entry.info.id, entry);

    entry.disposers.push(child.onData((data) => this.append(entry, data)).dispose);
    entry.disposers.push(
      child.onExit(({ exitCode }) => {
        entry.info.exitCode = exitCode;
        this.notify(entry);
        // Keep the corpse briefly so a client still polling sees the last line and the code.
        entry.reap = setTimeout(() => this.remove(entry.info.id), EXITED_RETENTION_MS);
        entry.reap.unref?.();
      }).dispose,
    );

    return { ok: true, session: entry.info };
  }

  get(id: string): TerminalSessionInfo | null {
    return this.entries.get(id)?.info ?? null;
  }

  /**
   * Fold one `ps` snapshot into every live session's label and busy flag.
   *
   * Takes the rows rather than reading them so ONE snapshot serves every tab (and so this stays
   * synchronous and testable). An exited session is left exactly as it was: its last command is
   * the most useful thing its tab can still say.
   *
   * `rows === null` is a host whose process table cannot be read. Busy-ness becomes `null`
   * ("cannot say", which the close warning treats as "ask"), and the LABEL is left alone — a tab
   * keeps whatever it was last known to be running rather than being reset by an absence of
   * information.
   */
  observe(rows: readonly ProcessRow[] | null): void {
    for (const entry of this.entries.values()) {
      if (entry.info.exitCode !== null) continue;
      if (rows === null) {
        entry.info.busy = null;
        continue;
      }
      entry.info.busy = hasForeground(rows, entry.pty.pid);
      const running = foregroundCommand(rows, entry.pty.pid);
      // Only a command REPLACES the label; going idle keeps the last one (spec §6).
      if (running) entry.info.label = running;
    }
  }

  /** The lowest `Terminal N` this task does not already have. Reusing a freed number keeps a
   *  long-lived task from counting up to `Terminal 47` after a day of opening and closing. */
  private nextOrdinal(runId: string): number {
    const taken = new Set(
      [...this.entries.values()].filter((entry) => entry.info.runId === runId).map((entry) => entry.ordinal),
    );
    let ordinal = 1;
    while (taken.has(ordinal)) ordinal += 1;
    return ordinal;
  }

  listFor(runId: string): TerminalSessionInfo[] {
    return [...this.entries.values()].filter((entry) => entry.info.runId === runId).map((entry) => entry.info);
  }

  /** Keystrokes. A write to an exited shell is dropped rather than thrown — the client may not
   *  have learned about the exit yet. */
  write(id: string, data: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exitCode !== null) return false;
    entry.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.info.exitCode !== null) return false;
    entry.info.cols = clampDimension(cols, entry.info.cols);
    entry.info.rows = clampDimension(rows, entry.info.rows);
    entry.pty.resize(entry.info.cols, entry.info.rows);
    return true;
  }

  /** Output since `cursor`. A cursor of 0 replays the whole retained scrollback, which is what a
   *  reconnecting client wants. */
  read(id: string, cursor: number): TerminalRead | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const end = entry.dropped + entry.buffer.length;
    const from = Number.isFinite(cursor) ? Math.max(0, Math.min(Math.trunc(cursor), end)) : 0;
    const truncated = from < entry.dropped;
    const start = truncated ? 0 : from - entry.dropped;
    return {
      data: entry.buffer.slice(start),
      cursor: end,
      truncated,
      exitCode: entry.info.exitCode,
    };
  }

  /** Fires whenever output arrives or the shell exits. The WS topic's publisher is the only
   *  intended caller; the returned release is idempotent. */
  subscribe(id: string, listener: () => void): () => void {
    const entry = this.entries.get(id);
    if (!entry) return () => {};
    entry.listeners.add(listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.listeners.delete(listener);
    };
  }

  /**
   * Stop a session and its whole process tree, and FORGET it.
   *
   * SIGHUP first, because that is what a closing terminal sends and what shells and well-behaved
   * children treat as "your terminal went away"; SIGKILL after a grace period for anything that
   * ignored it. Both go to the process GROUP (`-pid`) so the tree dies with the shell. The
   * binding's own `kill()` is the fallback: it is all Windows has, and it is the backstop if the
   * group signal fails because the leader is already gone.
   *
   * The entry goes NOW rather than after `EXITED_RETENTION_MS`, because every caller of this is
   * an EXPLICIT stop — the tab's X, an archive, a delete. The retention exists for the other
   * case, a shell that exited on its own, whose last line and exit code a still-polling client
   * has not read yet. Retaining an explicitly closed session instead PUT THE TAB BACK on the
   * next poll, because the drawer reconciles its strip against `listFor`, and made a drawer
   * reopened inside that minute reattach to the corpse instead of starting a fresh shell — both
   * contrary to spec §6 ("Confirming closes the terminal session and stops its process tree",
   * and after an unarchive the drawer "has no tabs").
   */
  kill(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    signalTree(entry.pty, 'SIGHUP');
    // Unconditional, where this used to re-check `entries.has`: the entry is dropped below, and a
    // SIGKILL aimed at a group that has already gone is swallowed inside `signalTree`.
    const force = setTimeout(() => signalTree(entry.pty, 'SIGKILL'), 2_000);
    force.unref?.();
    this.remove(id);
    return true;
  }

  /** Stop every session, synchronously enough for a shutdown handler. A cezar restart stops all
   *  terminal sessions and their children (spec §6) — nothing else in the process does this, so
   *  it has to be wired into the signal handlers rather than relying on process-group inheritance:
   *  a PTY child is deliberately in its OWN group and so does NOT receive the Ctrl-C that reaches
   *  cezar's foreground group. */
  closeAll(): void {
    for (const entry of [...this.entries.values()]) {
      signalTree(entry.pty, 'SIGKILL');
      this.remove(entry.info.id);
    }
  }

  /** Drop this registry from the process-wide set. For tests; a server keeps one for its life. */
  dispose(): void {
    this.closeAll();
    registries.delete(this);
  }

  private append(entry: Entry, data: string): void {
    if (this.urls) {
      this.urls.record(entry.info.runId, entry.scanTail + data);
      entry.scanTail = (entry.scanTail + data).slice(-SCAN_OVERLAP);
    }
    entry.buffer += data;
    const overflow = entry.buffer.length - SCROLLBACK_LIMIT;
    if (overflow > 0) {
      entry.buffer = entry.buffer.slice(overflow);
      entry.dropped += overflow;
    }
    this.notify(entry);
  }

  private notify(entry: Entry): void {
    for (const listener of [...entry.listeners]) listener();
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.reap);
    for (const dispose of entry.disposers) {
      try {
        dispose();
      } catch {
        // A binding that already tore its emitters down is not an error here.
      }
    }
    entry.listeners.clear();
    this.entries.delete(id);
  }
}

/** Signal the PTY's process group, falling back to the binding's own kill. */
function signalTree(pty: PtyProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pty.pid, signal);
      return;
    } catch {
      // Already gone, or no group (a binding that did not call setsid) — fall through.
    }
  }
  try {
    pty.kill(process.platform === 'win32' ? undefined : signal);
  } catch {
    // Already reaped.
  }
}

/** The child's environment: the server's own, plus a TERM the emulator understands.
 *
 *  `TERM` is set because a PTY with no TERM makes programs fall back to dumb output — no colours,
 *  no cursor addressing — which would make the terminal look broken rather than plain. */
function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(1, Math.trunc(value)));
}
