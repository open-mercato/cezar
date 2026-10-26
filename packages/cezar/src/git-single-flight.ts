/**
 * One git process per identical read, however many callers ask for it at once.
 *
 * The cockpit polls a task's git state (`/runs/:id/git/status` every 10 s while live, again on
 * every window focus, once per open tab or device), and the repo view does the same for the
 * project checkout. On a fast disk each poll finishes long before the next one, so nothing
 * overlaps. On a slow one — exFAT through macOS fskit while agents render video onto the same
 * volume — a single `git status` can take minutes, and every poll that arrived meanwhile spawned
 * ANOTHER identical process: a live cockpit was seen holding ~25 of them, each competing for the
 * disk the first one was waiting on, and a `/continue` queued behind them never answered.
 *
 * So at most ONE process per (cwd, argv) runs, plus at most one queued behind it. A caller that
 * arrives while one is running does not join it — that process may have started before the
 * caller's own write (an agent's last edit, then the settle check asking "anything to review?"),
 * and a stale "no" there settles a run as done with work still in the tree. It joins the queued
 * follow-up instead, which starts only after the running one ends, so every caller gets an answer
 * from a process that began after it asked, and any number of pollers cost at most two.
 *
 * Only commands that read (or, for `add -N .`, write an idempotent intent-to-add) are coalesced;
 * anything that changes refs, the index for real, or the remote always runs on its own. Calls with a custom env (a scratch `GIT_INDEX_FILE`) are never
 * coalesced — the env is part of what the command means.
 */

/** Subcommands whose concurrent duplicates are indistinguishable from one run. */
const READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'rev-parse',
  'rev-list',
  'merge-base',
  'for-each-ref',
  'ls-files',
]);

function coalescable(args: readonly string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined) return false;
  if (READ_SUBCOMMANDS.has(sub)) return true;
  // `branch --list` / `worktree list` read; every other spelling of those creates or deletes.
  if (sub === 'branch') return rest.includes('--list');
  if (sub === 'worktree') return rest[0] === 'list';
  // Intent-to-add of everything: idempotent, and the one write every diff surface starts with.
  if (sub === 'add') return rest.length === 2 && rest[0] === '-N' && rest[1] === '.';
  return false;
}

interface Slot {
  running: Promise<unknown>;
  /** The follow-up every caller that arrived during `running` shares; starts when it ends. */
  next?: Promise<unknown>;
}

const slots = new Map<string, Slot>();

/**
 * Run `spawn` for this (cwd, argv), coalescing concurrent identical coalescable calls as the
 * module note describes. `hasEnv` opts the call out entirely.
 */
export function gitSingleFlight<T>(
  cwd: string,
  args: readonly string[],
  hasEnv: boolean,
  spawn: () => Promise<T>,
): Promise<T> {
  if (hasEnv || !coalescable(args)) return spawn();
  const key = `${cwd}\0${args.join('\0')}`;
  const slot = slots.get(key);
  if (!slot) return start(key, spawn);
  if (!slot.next) {
    const settled = slot.running.then(() => undefined, () => undefined);
    slot.next = settled.then(() => {
      slot.next = undefined;
      return start(key, spawn);
    });
  }
  return slot.next as Promise<T>;
}

function start<T>(key: string, spawn: () => Promise<T>): Promise<T> {
  const running = spawn().finally(() => {
    const current = slots.get(key);
    if (current?.running === running && !current.next) slots.delete(key);
  });
  const existing = slots.get(key);
  if (existing) existing.running = running;
  else slots.set(key, { running });
  return running;
}

/** Test seam: how many distinct (cwd, argv) keys have a process running or queued. */
export function gitInFlightCount(): number {
  return slots.size;
}
