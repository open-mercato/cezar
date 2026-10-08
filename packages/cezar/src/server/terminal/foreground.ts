import { execFile } from 'node:child_process';

/**
 * What a terminal session is RUNNING right now (spec `.ai/specs/2026-10-07-task-workspace.md`
 * §6: "while a command runs, show that command as the tab name, and keep that name when it
 * finishes until another command runs").
 *
 * Read from the process table rather than from what the user typed. Typing is the wrong source:
 * it misses anything started by a script, by a key binding, or by a command the shell rewrote,
 * and it would have to re-implement line editing to know when a line was actually submitted.
 * A shell's live child IS the running command, by definition.
 *
 * The same answer drives the close warning — "is there a process to lose" is exactly "does this
 * shell have a child" — so one mechanism serves both and the two can never disagree.
 *
 * Same constraints as `core/process-usage.ts`, which samples the same table for the runs table:
 * a missing or failing `ps` (Windows, exotic containers) degrades silently to "nothing running",
 * never an error; parsing and the tree walk are pure and table-testable; and one snapshot serves
 * every session rather than one `ps` per tab.
 */

/** One parsed `ps` row. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Parse `ps -axo pid=,ppid=,command=` (the `=` suffixes suppress headers on darwin and linux
 * alike). `command` is the rest of the line, spaces and all, so it keeps its arguments.
 * Malformed rows are skipped — `ps` racing process exits can truncate them.
 */
export function parseProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
  }
  return rows;
}

/**
 * The command a shell is running, or null when it is sitting at its prompt.
 *
 * The shell's FIRST DIRECT CHILD names the tab, and the walk stops there — it does not descend.
 * That is deliberate and it is the whole point: `npm run dev` spawns a `sh -c vite` which spawns
 * `node vite`, and the name worth showing is the one the user typed, which is the generation
 * nearest the shell. Descending would reach the leaf and show `node`, which distinguishes
 * nothing when three tabs are all running something through node.
 *
 * A shell that forked several children (`make -j`) is named by the first of them, which is the
 * one it started first and the one a user recognises; no single name describes the fan-out, and
 * picking the first is better than picking none.
 *
 * Deliberately ignores the shell's own re-execs and anything that is not a direct child: a
 * session leader's group can contain unrelated jobs, and attributing those to this tab would be
 * a lie. A grandchild whose parent has exited is reparented away from this shell by the OS, so
 * it is no longer this tab's business either.
 */
export function foregroundCommand(rows: readonly ProcessRow[], shellPid: number): string | null {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const children = byParent.get(shellPid);
  if (!children || children.length === 0) return null;
  // More than one child is a fan-out; name it by the first, which is the one the shell started
  // first and the one a user recognises.
  return tidyCommand(children[0]!.command);
}

/** True when the shell has a direct child — "there is something to lose on close". Direct, for
 *  the reason above: anything deeper either has a live parent here too, or has been reparented
 *  off this shell entirely. */
export function hasForeground(rows: readonly ProcessRow[], shellPid: number): boolean {
  return rows.some((row) => row.ppid === shellPid);
}

/**
 * A command line shortened to something that fits a tab.
 *
 * Absolute paths become their basename (`/opt/homebrew/bin/node server.js` → `node server.js`),
 * because the directory is never what distinguishes one tab from another. The length cap is
 * generous enough to keep `npm run dev:server` whole and short enough that a tab strip stays a
 * strip.
 */
export function tidyCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed === '') return '';
  const [head, ...rest] = trimmed.split(/\s+/);
  const base = head!.includes('/') ? head!.slice(head!.lastIndexOf('/') + 1) : head!;
  const line = [base, ...rest].join(' ');
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** How long one `ps` snapshot is reused. A terminal tab's name does not need to be fresher than
 *  this, and it keeps a polling cockpit from spawning a `ps` per request. */
const SNAPSHOT_TTL_MS = 1_000;

let snapshot: { at: number; rows: ProcessRow[] } | undefined;
let inFlight: Promise<ProcessRow[] | null> | undefined;

/**
 * One shared, cached `ps` snapshot, or `null` when this host's process table cannot be read.
 *
 * Cached as the PROMISE while in flight so four tabs asking at once cost one `ps`, not four.
 *
 * NULL IS NOT AN EMPTY TABLE. This used to resolve a failure to `[]`, which read downstream as
 * the positive claim "nothing is running" — and on Windows, where there is no `ps` at all, that
 * claim silently disabled the close warning §6 requires: closing a tab mid-build took the whole
 * process tree without asking. "I cannot tell" has to be sayable, so that the one decision which
 * must fail safe can.
 */
export function processSnapshot(now = Date.now()): Promise<ProcessRow[] | null> {
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return Promise.resolve(snapshot.rows);
  if (inFlight) return inFlight;
  inFlight = readProcessTable()
    .then((rows) => {
      // A failed read is deliberately NOT cached: `ps` failing once (a transient EAGAIN under
      // load) should not freeze every tab's busy flag at "unknown" for the whole TTL.
      if (rows !== null) snapshot = { at: now, rows };
      return rows;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

/** Test seam: forget the cached snapshot. */
export function resetProcessSnapshot(): void {
  snapshot = undefined;
  inFlight = undefined;
}

function readProcessTable(): Promise<ProcessRow[] | null> {
  return new Promise((resolve) => {
    // Windows has no `ps`, and a hardened container can hide the table; both land on `null`,
    // which says "unknown" rather than "nothing running".
    execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : parseProcessRows(stdout));
    });
  });
}
