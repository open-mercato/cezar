import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from './paths.ts';

/**
 * A small number per task worktree, unique on this machine (spec
 * `.ai/specs/2026-10-10-task-slots.md`).
 *
 * Every task has its own tree, but a port is a property of the MACHINE: two worktrees that
 * both run the project's dev command both ask for :3000, and the second one fails — or worse,
 * the Browser column of one task frames the app of another. cezar cannot renumber a project's
 * ports for it. What it can do is hand every task one number nobody else on the machine holds
 * and let the project derive the rest: `PORT=$((3000 + CEZ_TASK_SLOT))`, a database named
 * `app_$CEZ_TASK_SLOT`.
 *
 * WHY FILES IN THE CEZAR HOME, and not a field on the run: the number has to be unique across
 * every project and every cezar process on the host, and a run store is one project's. A lease
 * is one file, taken with an exclusive create, so two processes cannot take the same one.
 *
 * WHY NOTHING RELEASES A SLOT: cezar has several ways a worktree ends — delete, archive,
 * retention, a crash — and a release hook on each is a list that will miss one. Instead a lease
 * names the worktree it belongs to, and a lease whose directory is gone is free. Reaping runs on
 * every lookup, so the only signal used is the one that is true everywhere.
 *
 * A home that cannot be written, or a host with every slot taken, yields no slot at all: the
 * task runs exactly as it did before slots existed.
 */

/** Two digits, so a derived port stays a readable offset and a derived name stays short. */
export const MAX_TASK_SLOTS = 99;

/** Each slot's own block of a hundred ports, clear of the well-known dev ports below it and the
 *  ephemeral range above it (Linux starts at 32768). */
const PORT_BLOCK_START = 20000;
const PORT_BLOCK_SIZE = 100;

interface Lease {
  runId: string;
  worktree: string;
}

function slotsDir(env: NodeJS.ProcessEnv): string {
  return join(cezarHomeDir(env), 'task-slots');
}

function readLease(path: string): Lease | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Lease> | null;
    if (raw && typeof raw.runId === 'string' && typeof raw.worktree === 'string') {
      return { runId: raw.runId, worktree: raw.worktree };
    }
  } catch {
    // unreadable or half-written
  }
  return null;
}

/**
 * The slot held by `runId`'s worktree, taking one when it holds none. `undefined` when no slot
 * can be had. Never throws.
 */
export function acquireTaskSlot(
  runId: string,
  worktree: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  try {
    const dir = slotsDir(env);
    assertCezarHomeWriteIsSandboxed(dir, env);
    mkdirSync(dir, { recursive: true });
    const taken = new Set<number>();
    for (const name of readdirSync(dir)) {
      const slot = /^(\d+)\.json$/.exec(name)?.[1];
      if (!slot) continue;
      const path = join(dir, name);
      const lease = readLease(path);
      if (lease?.runId === runId && lease.worktree === worktree) return Number(slot);
      // A lease that cannot be read is KEPT taken: it may be another process mid-write, and
      // handing its number out twice is the one failure this file exists to prevent.
      if (lease && !existsSync(lease.worktree)) rmSync(path, { force: true });
      else taken.add(Number(slot));
    }
    for (let slot = 1; slot <= MAX_TASK_SLOTS; slot += 1) {
      if (taken.has(slot)) continue;
      try {
        writeFileSync(join(dir, `${slot}.json`), JSON.stringify({ runId, worktree } satisfies Lease), {
          flag: 'wx',
          mode: 0o600,
        });
        return slot;
      } catch {
        // Another process took it between the listing and the create — try the next one.
      }
    }
  } catch {
    // read-only home, or the sandbox guard: no slot
  }
  return undefined;
}

/**
 * What a process started for a task is told about its slot.
 *
 * A task with no worktree of its own runs on the shared stack and has no slot — but its keys
 * are still PRESENT, and empty. Every spawn here layers onto `process.env`, so a key that was
 * merely omitted would let a value inherited by this cezar through: a cezar started from inside
 * a task's terminal would hand that task's slot to every in-place run it starts.
 */
export function taskSlotEnv(
  runId: string,
  worktree: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { CEZ_TASK_SLOT: string; CEZ_TASK_PORT_BASE: string } {
  const slot = worktree ? acquireTaskSlot(runId, worktree, env) : undefined;
  if (slot === undefined) return { CEZ_TASK_SLOT: '', CEZ_TASK_PORT_BASE: '' };
  return {
    CEZ_TASK_SLOT: String(slot),
    CEZ_TASK_PORT_BASE: String(PORT_BLOCK_START + slot * PORT_BLOCK_SIZE),
  };
}
