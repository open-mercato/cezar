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
 * Walks DOWN from the shell and reports the deepest single descendant: `npm run dev` spawns a
 * `sh -c vite`, which spawns `node vite`, and the name worth showing is the one the user typed,
 * not the leaf. So the FIRST generation is what names the tab — but a generation that forked
 * several children (a `make -j`) stops the walk, because no single name describes it.
 *
 * Deliberately ignores the shell's own re-execs and anything that is not a descendant: a session
 * leader's group can contain unrelated jobs, and attributing those to this tab would be a lie.
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

/** True when the shell has any descendant at all — "there is something to lose on close". */
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
let inFlight: Promise<ProcessRow[]> | undefined;

/**
 * One shared, cached `ps` snapshot.
 *
 * Cached as the PROMISE while in flight so four tabs asking at once cost one `ps`, not four.
 * Any failure resolves to an empty table, which reads downstream as "nothing is running" — the
 * honest degradation for a host whose process table we cannot see.
 */
export function processSnapshot(now = Date.now()): Promise<ProcessRow[]> {
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return Promise.resolve(snapshot.rows);
  if (inFlight) return inFlight;
  inFlight = readProcessTable()
    .then((rows) => {
      snapshot = { at: now, rows };
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

function readProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    // Windows has no `ps`; the catch-all below turns that into "nothing running", which is the
    // same answer this gives on a container with a hidden process table.
    execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : parseProcessRows(stdout));
    });
  });
}
